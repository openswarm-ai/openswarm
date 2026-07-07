"""Per-session persistent SDK client pool (lever A of the TTFT work, gated by
OSW_TTFT_PERSISTENT_CLIENT=1, default OFF). One live Claude CLI per session, reused across
follow-up turns so the ~0.5s subprocess + MCP boot is paid once, not per message.

Safety model, from the red-teamed plan: reuse is gated on a BOOT FINGERPRINT (a hash of every
boot-frozen input), never on session flags. Any change to the booted config (MCPActivate growing
mcp_servers, branch switch, compaction, provider env, selection-context system prompt) changes the
fingerprint and forces a dispose+respawn, so "live client with stale config" is unrepresentable.
Every error path collapses to dispose+respawn, which IS today's one-shot behavior, never worse."""

import asyncio
import hashlib
import json
import logging
import os
import time
from typing import Awaitable, Callable, Dict, List, Optional

from pydantic import BaseModel, ConfigDict, InstanceOf
from typeguard import typechecked

from backend.apps.agents.core.models import AgentSession

logger = logging.getLogger(__name__)

# Options entries that are per-turn or non-serializable; everything else is boot-frozen and hashed.
P_NON_BOOT_KEYS = frozenset({"can_use_tool", "stderr", "hooks", "resume", "fork_session"})


def persistent_client_enabled() -> bool:
    """Default ON (soak-proven: warm turns 535ms -> 6ms). Kill switch: OPENSWARM_PERSISTENT_CLIENT=0."""
    return os.environ.get("OPENSWARM_PERSISTENT_CLIENT", "1") != "0"


# Per-session field-level digests from the last fingerprint call; lets a mismatch log WHICH boot field drifted (probe-gated diagnostics only).
p_last_field_digests: Dict[str, Dict[str, str]] = {}


@typechecked
def boot_fingerprint(options_kwargs: Dict, session: AgentSession) -> str:
    """Hash of every input the CLI subprocess freezes at boot. Includes the full mcp_servers config
    (so MCPActivate / model-env changes respawn), the composed system prompt (so per-turn selection
    context respawns instead of silently not applying), branch, and the compaction cutoff (else a
    live client would keep the untrimmed transcript forever)."""
    frozen = {k: v for k, v in options_kwargs.items() if k not in P_NON_BOOT_KEYS}
    frozen["p_branch"] = session.active_branch_id
    frozen["p_compacted_through"] = session.compacted_through_msg_id
    # Pool diagnostics (OPENSWARM_POOL_DIAG=1): on a respawn, names WHICH boot field drifted; the tool for debugging respawn churn (e.g. the thinking short/long-prompt flip) in the field.
    if os.environ.get("OPENSWARM_POOL_DIAG") == "1":
        digests = {k: hashlib.sha256(json.dumps(v, sort_keys=True, default=str).encode()).hexdigest()[:10] for k, v in frozen.items()}
        prev = p_last_field_digests.get(session.id)
        if prev is not None:
            changed = [k for k in digests if prev.get(k) != digests.get(k)] + [k for k in prev if k not in digests]
            if changed:
                logger.info(f"[client-pool] {session.id}: fingerprint fields changed: {sorted(set(changed))}")
        p_last_field_digests[session.id] = digests
    blob = json.dumps(frozen, sort_keys=True, default=str)
    return hashlib.sha256(blob.encode()).hexdigest()


class ClientHandle(BaseModel):
    model_config = ConfigDict(validate_assignment=True)

    fingerprint: str
    client: InstanceOf[object]
    lock: InstanceOf[asyncio.Lock]
    connected_at: float
    last_used: float
    turns_served: int = 0


# A pooled CLI holds ~100MB+ per session; evict clients idle past this so parked chats don't accumulate subprocesses (respawn on the next message is the normal cold path).
IDLE_EVICT_SECONDS = float(os.environ.get("OSW_CLIENT_IDLE_EVICT_SECONDS", "1800"))


@typechecked
async def evict_idle_clients(pool: Dict[str, "ClientHandle"]) -> None:
    """Dispose every handle idle past the TTL, skipping any mid-turn (lock held)."""
    now = time.monotonic()
    for sid in list(pool.keys()):
        handle = pool.get(sid)
        if handle is None or handle.lock.locked():
            continue
        if now - handle.last_used > IDLE_EVICT_SECONDS:
            logger.info(f"[client-pool] {sid}: idle-evict after {int(now - handle.last_used)}s")
            await dispose_client(pool, sid)


@typechecked
async def acquire_client(
    pool: Dict[str, ClientHandle],
    session_id: str,
    fingerprint: str,
    connect_fn: Callable[[], Awaitable[object]],
    force_respawn: bool = False,
) -> ClientHandle:
    """Return a live client whose boot matches `fingerprint`, connecting fresh when there is none,
    the fingerprint mismatches, or the caller demands a fresh session (needs_fresh/fork consumed
    upstream, so the flag must be read BEFORE build_agent_options and passed in)."""
    await evict_idle_clients(pool)
    existing = pool.get(session_id)
    if existing is not None:
        if not force_respawn and existing.fingerprint == fingerprint:
            existing.last_used = time.monotonic()
            return existing
        reason = "force_respawn" if force_respawn else "fingerprint_changed"
        logger.info(f"[client-pool] {session_id}: respawn ({reason})")
        await dispose_client(pool, session_id)
    client = await connect_fn()
    now = time.monotonic()
    handle = ClientHandle(
        fingerprint=fingerprint, client=client, lock=asyncio.Lock(), connected_at=now, last_used=now,
    )
    pool[session_id] = handle
    logger.info(f"[client-pool] {session_id}: connected fresh client")
    return handle


@typechecked
async def dispose_client(pool: Dict[str, ClientHandle], session_id: str) -> None:
    """Pop first so a concurrent turn can never re-grab a disposing client, then disconnect
    (terminates the CLI subprocess). Never raises: teardown must not block a turn or a close."""
    handle = pool.pop(session_id, None)
    if handle is None:
        return
    try:
        await handle.client.disconnect()
    except Exception:
        logger.exception(f"[client-pool] {session_id}: disconnect failed (subprocess may already be dead)")


@typechecked
def dispose_client_soon(pool: Dict[str, ClientHandle], session_id: str) -> None:
    """Sync-context teardown (purge_session_memory): pop now, disconnect in a detached task."""
    handle = pool.pop(session_id, None)
    if handle is None:
        return

    async def p_bg() -> None:
        try:
            await handle.client.disconnect()
        except Exception:
            logger.exception(f"[client-pool] {session_id}: background disconnect failed")

    try:
        asyncio.get_running_loop().create_task(p_bg())
    except RuntimeError:
        logger.warning(f"[client-pool] {session_id}: no loop for background disconnect; subprocess reaped on exit")


@typechecked
async def dispose_all_clients(pool: Dict[str, ClientHandle]) -> None:
    """Process-shutdown hook: a persistent subprocess outlives turns, so uvicorn reload/quit would
    orphan one CLI per live session without this."""
    for sid in list(pool.keys()):
        await dispose_client(pool, sid)
