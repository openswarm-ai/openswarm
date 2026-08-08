"""Per-session flight recorder: a fixed breadcrumb ring appended at points that already log,
flushed into a diagnostic envelope ONLY when an error surfaces (or a silent recovery is counted).
The happy path pays one O(1) deque append per event and nothing else; nothing here touches disk
or network on its own."""

import os
import threading
import time
from collections import deque
from typing import Dict, List, Optional

from typeguard import typechecked

# Kill switch: OSW_FLIGHT=0 turns every sensor into a no-op, which is also how the A/B that proves
# the recorder costs nothing is run.
P_ENABLED = os.environ.get("OSW_FLIGHT", "1") != "0"
P_RING_SIZE = 64
p_lock = threading.Lock()
p_rings: Dict[str, deque] = {}
p_sessions_provider = None


def set_sessions_provider(provider) -> None:
    """agent_manager registers its live sessions dict once so envelopes built anywhere (error
    handlers have no manager handle) still carry a real concurrency snapshot."""
    global p_sessions_provider
    p_sessions_provider = provider


@typechecked
def crumb(session_id: str, label: str, **meta: object) -> None:
    """Append one breadcrumb; cheap enough for every retry decision and phase stamp."""
    if not P_ENABLED:
        return
    entry = {"l": label, "t": round(time.time(), 3)}
    for k, v in meta.items():
        if v is not None:
            entry[k] = v if isinstance(v, (int, float, bool)) else str(v)[:200]
    with p_lock:
        ring = p_rings.get(session_id)
        if ring is None:
            ring = deque(maxlen=P_RING_SIZE)
            p_rings[session_id] = ring
        ring.append(entry)


@typechecked
def drop_session(session_id: str) -> None:
    """Sessions are deleted often; their crumbs must not accumulate forever."""
    with p_lock:
        p_rings.pop(session_id, None)


@typechecked
def breadcrumbs(session_id: str, last: int = 20) -> List[dict]:
    with p_lock:
        ring = p_rings.get(session_id)
        return list(ring)[-last:] if ring else []


@typechecked
def lane_for_model(model: Optional[str]) -> str:
    """The routing lane is a first-class confounder: cc/cx/gc ride the local router, api goes direct."""
    m = model or ""
    if m.endswith("-cc") or m.startswith("cc/"):
        return "cc"
    if m.endswith("-cx") or m.startswith("cx/"):
        return "cx"
    if m.startswith(("gc/", "gemini", "ag/")):
        return "gc"
    if m.startswith(("openrouter/", "cp-")):
        return "openrouter" if m.startswith("openrouter/") else "custom"
    return "api"


@typechecked
def concurrency_snapshot(sessions: Dict[str, object]) -> dict:
    """The tandem set at event time, read from state already in memory; assembled only when an
    envelope is being built, never on the hot path."""
    try:
        statuses = [getattr(s, "status", None) for s in sessions.values()]
        return {
            "sessions_total": len(statuses),
            "turns_running": sum(1 for s in statuses if s == "running"),
        }
    except Exception:
        return {"sessions_total": -1, "turns_running": -1}


@typechecked
def journey_auth_context() -> dict:
    """Who the user is and where they are in the product when it broke. An error during onboarding
    on a free trial is a DIFFERENT bug from the same error for a returning own-key user, and without
    this they look identical in analytics."""
    try:
        from backend.apps.settings.store import load_settings
        st = load_settings()
        onboarding = getattr(st, "onboarding_v3", None)
        return {
            "stage": "onboarding" if onboarding in (None, "", "in_progress") else "returning",
            "signed_in": bool(getattr(st, "user_id", None)),
            "signin_method": getattr(st, "signin_method", None),
            "connection_mode": getattr(st, "connection_mode", "own_key"),
            "has_own_key": bool(getattr(st, "anthropic_api_key", None) or getattr(st, "openai_api_key", None)),
        }
    except Exception:
        return {"stage": "unknown", "signed_in": False}


@typechecked
def build_envelope(
    session_id: str,
    family: str,
    subkind: str,
    model: Optional[str],
    phase: str,
    attempts: int,
    sessions: Optional[Dict[str, object]] = None,
) -> dict:
    """Everything a stranger needs to diagnose the failure without the machine in front of them."""
    return {
        "family": family,
        "subkind": subkind,
        "lane": lane_for_model(model),
        "model": model,
        "phase": phase,
        "attempts": attempts,
        "breadcrumbs": breadcrumbs(session_id),
        "journey": journey_auth_context(),
        "concurrency": concurrency_snapshot(sessions if sessions is not None else (p_sessions_provider() if p_sessions_provider else {})),
    }


@typechecked
def record_recovery(session_id: str, net: str, model: Optional[str], attempts: int, sessions: Optional[Dict[str, object]] = None) -> None:
    """The near-miss ledger: a silent recovery the user never saw still counts in analytics, so
    'how often do the nets fire' has a denominator. Fire-and-forget; failures never block the turn."""
    crumb(session_id, "recovered", net=net, attempts=attempts)
    try:
        from backend.apps.service.client import submit_diagnostic
        submit_diagnostic({
            "kind": "recovered",
            "subkind": net,
            "session_id": session_id[:8],
            "lane": lane_for_model(model),
            "model": model,
            "attempts": attempts,
            "journey": journey_auth_context(),
            "concurrency": concurrency_snapshot(sessions or {}),
        })
    except Exception:
        pass
