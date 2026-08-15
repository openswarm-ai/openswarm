"""Did the session's core MCP server actually connect?

The watchdog next door handles a sidecar that freezes MID-CALL. This is the other half, and it is
the one that matches the original report: when the sidecar is unhealthy at CONNECT time, the tools
never register at all, so every `mcp__openswarm-core__*` call comes back "No such tool available"
INSTANTLY. Nothing hangs, no tool result is produced, no hook fires, and the agent spends the whole
session hunting for tools that were never there (measured 2026-08-14: 25 messages of Glob and Bash
before it gave up, and the fact it was asked to save was silently lost).

The CLI tells us, every turn, in its init message:

    mcp_servers: [{'name': 'openswarm-core', 'status': 'connected'}]

so this is a fact we can read rather than a symptom we have to infer.
"""

import logging
from typing import Optional

from typeguard import typechecked

logger = logging.getLogger(__name__)

CORE_SERVER = "openswarm-core"


@typechecked
def core_mcp_status(init_payload: object) -> Optional[str]:
    """The reported status of our core server in an init message, or None when the message says
    nothing about it (a different subtype, an older CLI, a shape we don't recognise). None means
    "no opinion", never "broken": inventing a failure here would respawn healthy sessions."""
    data = init_payload
    if isinstance(data, dict) and isinstance(data.get("data"), dict):
        data = data["data"]
    if not isinstance(data, dict):
        return None
    servers = data.get("mcp_servers")
    if not isinstance(servers, list):
        return None
    for entry in servers:
        if isinstance(entry, dict) and entry.get("name") == CORE_SERVER:
            status = entry.get("status")
            return str(status) if status is not None else None
    return None


@typechecked
def core_mcp_failed_to_connect(init_payload: object) -> bool:
    """True only when the CLI explicitly reports our core server as NOT connected. Silence, an
    unknown shape, or a missing entry all read as False, so this can only ever fire on a positive
    statement of failure."""
    status = core_mcp_status(init_payload)
    return status is not None and status != "connected"


@typechecked
def note_core_mcp_health(session: object, session_id: str, init_payload: object) -> bool:
    """Arm a fresh-session rebuild when the core server did not connect. The next turn respawns the
    CLI (the machinery ENG-258 already uses for unclassified failures), which is the only cure:
    MCP registration happens once at connect, so a toolless session stays toolless forever.
    Returns whether it armed."""
    if not core_mcp_failed_to_connect(init_payload):
        return False
    status = core_mcp_status(init_payload)
    logger.warning(
        f"Agent {session_id}: core MCP server reported '{status}', not connected; "
        "arming a fresh CLI session so the agent is not left without its tools"
    )
    try:
        session.needs_fresh_session = True   # type: ignore[attr-defined]
    except Exception:
        return False
    try:
        from backend.apps.service.client import submit_diagnostic
        submit_diagnostic({
            "kind": "core_mcp_not_connected",
            "session_id": session_id,
            "status": status,
        })
    except Exception:
        pass
    return True
