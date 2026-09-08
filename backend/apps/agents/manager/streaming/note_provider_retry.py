"""The CLI retries provider 500s/429s by itself, up to 10 attempts with backoffs measured in tens
of seconds, and tells nobody. To the user the card just sits there; to us the turn looks clean.

This turns each of those `api_retry` system events into a breadcrumb, so a turn that eventually
dies carries "the provider 500'd four times first" in its envelope instead of an unexplained
timeout. Counting it as a RECOVERED near-miss happens later, at turn end, because a retry that is
still in flight has not recovered anything yet."""

from collections import Counter
from typing import Literal, Optional

from typeguard import typechecked

from backend.apps.agents.core import flight_recorder
from backend.apps.agents.manager.streaming.state import TurnState


RetryKind = Literal["unreachable", "auth", "rate_limit", "provider_error", "other"]


@typechecked
def retry_kind(status: object, error: object) -> RetryKind:
    """What the CLI is actually waiting on. Fleet, 7 days to 2026-09-07: 121 of 245 retries had NO status at
    all (the request never got an answer: our router down or restarting, or the network gone), 98 were the
    router's own 502 for an upstream it could not reach, 13 were 429s. One word for all of them hid that."""
    if not isinstance(status, int):
        return "unreachable"
    if status in (401, 403) or error == "authentication_failed":
        return "auth"
    if status == 429:
        return "rate_limit"
    if status >= 500:
        return "provider_error"
    return "other"


@typechecked
def note_provider_retry(session_id: str, raw: object, turn: TurnState) -> None:
    """Record one CLI-internal provider retry. Never raises; diagnostics must not break a turn."""
    try:
        data = raw.get("data", {}) if isinstance(raw, dict) else {}
        if not isinstance(data, dict):
            data = {}
        turn.provider_retries += 1
        delay_ms = data.get("retry_delay_ms")
        turn.provider_retry_wait_ms += int(delay_ms) if isinstance(delay_ms, int) else 0
        p_kind = retry_kind(data.get("error_status"), data.get("error"))
        turn.provider_retry_kinds.append(p_kind)
        flight_recorder.crumb(
            session_id,
            "provider-retry",
            status=data.get("error_status"),
            error=str(data.get("error", ""))[:40],
            kind=p_kind,
            attempt=data.get("attempt"),
            delay_ms=delay_ms,
        )
        # The card sat DEAD through these waits (30s+ with no explanation, ENG-178); a muted pill is honest without reading as an error.
        import asyncio
        from backend.apps.agents.core.ws_manager import ws_manager
        asyncio.get_running_loop().create_task(ws_manager.send_to_session(session_id, "agent:provider_retrying", {
            "session_id": session_id,
            "attempt": data.get("attempt"),
            "delay_ms": delay_ms if isinstance(delay_ms, int) else None,
            "kind": p_kind,
        }))
    except Exception:
        pass


@typechecked
def settle_provider_retries(session_id: str, turn: TurnState, model: Optional[str], sessions: Optional[dict] = None) -> None:
    """Called when a turn finishes cleanly: any retries it survived were a silent save, so they get
    a denominator in the near-miss ledger."""
    if turn.provider_retries <= 0:
        return
    flight_recorder.record_recovery(
        session_id, "provider-retry", model, turn.provider_retries, sessions,
        detail={"retry_kinds": dict(Counter(turn.provider_retry_kinds))},
    )
