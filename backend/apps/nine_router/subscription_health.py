"""Boot-time subscription health probe: catches a provider login that died while the app was
closed (refresh-token rotation, the "Breaking codex" class) so the UI can offer reconnect BEFORE
the user burns a failed turn discovering it. Probes SUBSCRIPTION lanes only (1 token of sub quota,
never a billable API key), and only a definitive auth-shaped 401/403 counts as dead: transient
429/5xx/timeouts stay silent so the pill can never cry wolf. Kill switch: OPENSWARM_BOOT_HEALTH=0."""

import asyncio
import logging
import os
import time
from typing import Awaitable, Callable, Dict, List, Optional

import httpx
from typeguard import typechecked

from backend.apps.nine_router.process import NINE_ROUTER_URL, is_running

logger = logging.getLogger(__name__)

PREFIX_BY_PROVIDER: Dict[str, str] = {
    "claude": "cc/",
    "codex": "cx/",
    "gemini-cli": "gemini/",
    "antigravity": "ag/",
}
LABEL_BY_PROVIDER: Dict[str, str] = {
    "claude": "Claude",
    "codex": "ChatGPT",
    "gemini-cli": "Gemini",
    "antigravity": "Gemini (Antigravity)",
}
P_AUTH_DEAD_MARKERS = ("authentication", "expired", "sign in", "signing in", "invalid_grant", "unauthorized", "invalid authentication")
P_PROBE_TIMEOUT_S = 25.0
P_CACHE_TTL_S = 300.0
# A codex refresh lands within 1-2 minutes (ENG-361); a "mid-refresh" 401 still standing at the next probe is a dead login.
P_ROTATION_WINDOW_S = 240.0

p_probe_lock = asyncio.Lock()
p_cached_result: Optional[List[Dict[str, str]]] = None
p_cached_at: float = 0.0
p_refreshing_since: Dict[str, float] = {}
p_rechecks: Dict[str, "asyncio.Task[None]"] = {}


@typechecked
def health_probe_enabled() -> bool:
    return os.environ.get("OPENSWARM_BOOT_HEALTH", "1") != "0"


@typechecked
def invalidate_health_cache() -> None:
    """Drop the cached verdict after a deliberate connect/disconnect, which makes it stale by definition."""
    global p_cached_result, p_cached_at
    p_cached_result = None
    p_cached_at = 0.0
    p_refreshing_since.clear()
    for t in p_rechecks.values():
        t.cancel()
    p_rechecks.clear()
    for t in p_reprobes.values():
        t.cancel()
    p_reprobes.clear()


@typechecked
def classify_auth_dead(status_code: int, body_text: str) -> bool:
    """Dead ONLY on a definitive auth failure; anything ambiguous reads healthy (silence beats a false reconnect prompt)."""
    if status_code not in (401, 403):
        return False
    low = body_text.lower()
    # A 401 that names its own recovery window ("reset after 1m 57s") is a token mid-refresh, not a
    # dead login; it heals itself and the banner would cry wolf while real chats work (caught live).
    if "reset after" in low or "try again in" in low:
        return False
    return any(m in low for m in P_AUTH_DEAD_MARKERS)


@typechecked
def classify_refreshing(status_code: int, body_text: str) -> bool:
    """An auth-shaped 401/403 that classify_auth_dead excused for naming a reset window. The router appends
    "(reset after Ns)" to EVERY error, so this text is also what a login that died days ago answers; the
    verdict has to come from time, not wording (a codex token expired on 08-30 wore it for six days)."""
    if status_code not in (401, 403):
        return False
    low = body_text.lower()
    return not classify_auth_dead(status_code, body_text) and any(m in low for m in P_AUTH_DEAD_MARKERS)


@typechecked
async def p_pick_probe_model(client: httpx.AsyncClient, prefix: str) -> Optional[str]:
    try:
        r = await client.get(f"{NINE_ROUTER_URL}/v1/models")
        if r.status_code != 200:
            return None
        ids = [m.get("id") for m in (r.json().get("data") or []) if isinstance(m, dict)]
        for i in ids:
            if isinstance(i, str) and i.startswith(prefix):
                return i
    except Exception:
        return None
    return None


@typechecked
async def p_probe_one(client: httpx.AsyncClient, model: str) -> str:
    """"dead" = definitive auth failure, "healthy" = answered, "refreshing" = auth failure naming a reset
    window, "unknown" = inconclusive (never reported)."""
    try:
        r = await client.post(
            f"{NINE_ROUTER_URL}/v1/messages",
            json={"model": model, "max_tokens": 1, "messages": [{"role": "user", "content": "hi"}]},
            headers={"x-api-key": "9router", "anthropic-version": "2023-06-01"},
        )
        if r.status_code < 400:
            return "healthy"
        body = r.text or ""
        if classify_auth_dead(r.status_code, body):
            return "dead"
        return "refreshing" if classify_refreshing(r.status_code, body) else "unknown"
    except Exception:
        return "unknown"


@typechecked
def refreshing_verdict(provider: str, now: float) -> bool:
    """True once a provider has answered "refreshing" across more than the rotation window."""
    first = p_refreshing_since.setdefault(provider, now)
    if now - first >= P_ROTATION_WINDOW_S:
        logger.warning(f"[sub-health] {provider}: the mid-refresh 401 has stood for {int(now - first)}s, past the rotation window; reporting it dead")
        return True
    logger.info(f"[sub-health] {provider}: 401 names a reset window; waiting one rotation window before calling it dead")
    return False


@typechecked
async def probe_subscription_health(connections: List[Dict]) -> List[Dict[str, str]]:
    """Probe each active subscription connection with a 1-token turn; returns [{provider, label}]
    for the definitively auth-dead ones. Cached for 5 minutes; concurrent callers share one run."""
    global p_cached_result, p_cached_at
    if not health_probe_enabled() or not is_running():
        return []
    async with p_probe_lock:
        if p_cached_result is not None and time.monotonic() - p_cached_at < P_CACHE_TTL_S:
            return p_cached_result
        # One probe per PROVIDER: db.json can hold several active rows for one provider (a stale +
        # a fresh connect), and probing per row reported "ChatGPT and ChatGPT" in the banner.
        p_seen: set = set()
        subs = []
        for c in connections:
            if not (isinstance(c, dict) and c.get("provider") in PREFIX_BY_PROVIDER and c.get("isActive")):
                continue
            if c.get("provider") in p_seen:
                continue
            p_seen.add(c.get("provider"))
            subs.append(c)
        dead: List[Dict[str, str]] = []
        if subs:
            async with httpx.AsyncClient(timeout=P_PROBE_TIMEOUT_S) as client:
                for c in subs:
                    provider = str(c.get("provider"))
                    model = await p_pick_probe_model(client, PREFIX_BY_PROVIDER[provider])
                    if not model:
                        continue
                    verdict = await p_probe_one(client, model)
                    if verdict == "healthy":
                        p_refreshing_since.pop(provider, None)
                    elif verdict == "refreshing":
                        if refreshing_verdict(provider, time.monotonic()):
                            verdict = "dead"
                        else:
                            schedule_recheck(provider, model)
                    if verdict == "dead":
                        dead.append({"provider": provider, "label": LABEL_BY_PROVIDER[provider]})
                        logger.info(f"[sub-health] {provider}: auth dead (reconnect needed)")
        p_cached_result = dead
        p_cached_at = time.monotonic()
        return dead


@typechecked
def schedule_recheck(provider: str, model: str) -> bool:
    """The app asks the health question once per boot, so a "wait and see" verdict needs its own second look
    or it never gets one: re-probe after the rotation window and push the answer to every open dashboard."""
    live = p_rechecks.get(provider)
    if live is not None and not live.done():
        return False
    p_rechecks[provider] = asyncio.create_task(p_recheck(provider, model))
    return True


async def p_recheck(provider: str, model: str) -> None:
    global p_cached_result
    await asyncio.sleep(P_ROTATION_WINDOW_S)
    async with httpx.AsyncClient(timeout=P_PROBE_TIMEOUT_S) as client:
        verdict = await p_probe_one(client, model)
    if verdict == "healthy":
        p_refreshing_since.pop(provider, None)
        logger.info(f"[sub-health] {provider}: the token rotated; healthy on the recheck")
        return
    if verdict == "unknown":
        logger.info(f"[sub-health] {provider}: recheck inconclusive; not reported")
        return
    logger.warning(f"[sub-health] {provider}: still refusing auth {int(P_ROTATION_WINDOW_S)}s after the first 401; reporting it dead")
    entry = {"provider": provider, "label": LABEL_BY_PROVIDER[provider]}
    dead = [d for d in (p_cached_result or []) if d.get("provider") != provider] + [entry]
    p_cached_result = dead
    from backend.apps.agents.core.ws_manager import ws_manager
    await ws_manager.broadcast_global("subscriptions:health", {"dead": dead})
    schedule_reprobe(provider, model)


@typechecked
def note_auth_failure(provider: str) -> None:
    """A real request on this lane just failed auth. That is stronger evidence than a probe, so it ADVANCES
    the sighting (the clock starts now if it had not) and drops only the cached answer, so the next ask
    re-probes; it never resets the clock or cancels a scheduled recheck, which is what invalidating the
    whole cache on every 401 did (a lane agents kept hitting could restart its own window forever)."""
    global p_cached_result, p_cached_at
    if provider not in PREFIX_BY_PROVIDER:
        return
    p_refreshing_since.setdefault(provider, time.monotonic())
    p_cached_result = None
    p_cached_at = 0.0


@typechecked
async def report_dead_now(provider: str) -> bool:
    """The turn's retry failed auth as well: waiting cannot fix this login, so say so this second instead of
    at the next boot-time ask. Idempotent; returns False for a lane the probe does not cover."""
    global p_cached_result
    if provider not in PREFIX_BY_PROVIDER:
        return False
    for t in p_rechecks.values():
        t.cancel()
    p_rechecks.clear()
    entry = {"provider": provider, "label": LABEL_BY_PROVIDER[provider]}
    dead = [d for d in (p_cached_result or []) if d.get("provider") != provider] + [entry]
    p_cached_result = dead
    logger.warning(f"[sub-health] {provider}: a turn and its retry both failed auth; reporting it dead now")
    from backend.apps.agents.core.ws_manager import ws_manager
    await ws_manager.broadcast_global("subscriptions:health", {"dead": dead})
    schedule_reprobe(provider, None)
    return True


# A dead verdict owns its second look too. Once the pill was up nothing ever asked again, so a ChatGPT
# rotation slower than the turn's 75s retry told the user to reconnect a login that healed by itself.
P_REPROBE_S = 240.0
P_REPROBE_MAX_S = 1800.0
p_reprobes: Dict[str, "asyncio.Task[None]"] = {}
p_healed_hooks: List[Callable[[str], Awaitable[object]]] = []


@typechecked
def schedule_reprobe(provider: str, model: Optional[str], delay: float = P_REPROBE_S) -> bool:
    if provider not in PREFIX_BY_PROVIDER:
        return False
    live = p_reprobes.get(provider)
    if live is not None and not live.done() and live is not asyncio.current_task():
        live.cancel()
    p_reprobes[provider] = asyncio.create_task(p_reprobe(provider, model, delay))
    return True


async def p_reprobe(provider: str, model: Optional[str], delay: float) -> None:
    await asyncio.sleep(delay)
    async with httpx.AsyncClient(timeout=P_PROBE_TIMEOUT_S) as client:
        probe_model = model or await p_pick_probe_model(client, PREFIX_BY_PROVIDER[provider])
        verdict = await p_probe_one(client, probe_model) if probe_model else "unknown"
    if verdict == "healthy":
        await mark_healed(provider)
        return
    again = min(delay * 2, P_REPROBE_MAX_S)
    logger.info(f"[sub-health] {provider}: still {verdict} on the re-probe; asking again in {int(again)}s")
    schedule_reprobe(provider, probe_model, again)


@typechecked
async def mark_healed(provider: str) -> None:
    """The lane answers again: the pill closes this second and every chat that died on it resumes."""
    global p_cached_result, p_cached_at
    p_refreshing_since.pop(provider, None)
    dead = [d for d in (p_cached_result or []) if d.get("provider") != provider]
    p_cached_result = dead
    p_cached_at = time.monotonic()
    logger.info(f"[sub-health] {provider}: answered on the re-probe; closing the pill and resuming its chats")
    from backend.apps.agents.core.ws_manager import ws_manager
    await ws_manager.broadcast_global("subscriptions:health", {"dead": dead})
    for hook in list(p_healed_hooks):
        try:
            await hook(provider)
        except Exception:
            logger.exception(f"[sub-health] {provider}: a healed hook failed")

