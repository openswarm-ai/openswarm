"""The CLI retries provider 500s/429s by itself, up to 10 attempts with backoffs measured in tens
of seconds, and tells nobody. To the user the card just sits there; to us the turn looks clean.

This turns each of those `api_retry` system events into a breadcrumb, so a turn that eventually
dies carries "the provider 500'd four times first" in its envelope instead of an unexplained
timeout. Counting it as a RECOVERED near-miss happens later, at turn end, because a retry that is
still in flight has not recovered anything yet."""

from typing import Optional

from typeguard import typechecked

from backend.apps.agents.core import flight_recorder
from backend.apps.agents.manager.streaming.state import TurnState


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
        flight_recorder.crumb(
            session_id,
            "provider-retry",
            status=data.get("error_status"),
            error=str(data.get("error", ""))[:40],
            attempt=data.get("attempt"),
            delay_ms=delay_ms,
        )
    except Exception:
        pass


@typechecked
def settle_provider_retries(session_id: str, turn: TurnState, model: Optional[str], sessions: Optional[dict] = None) -> None:
    """Called when a turn finishes cleanly: any retries it survived were a silent save, so they get
    a denominator in the near-miss ledger."""
    if turn.provider_retries <= 0:
        return
    flight_recorder.record_recovery(session_id, "provider-retry", model, turn.provider_retries, sessions)
