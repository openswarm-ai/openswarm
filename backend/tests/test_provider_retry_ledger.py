"""The silent provider stall (Eric's "the ones that never get picked up").

The CLI retries provider 500s itself, up to 10 attempts, backing off in tens of seconds. Nothing
reached our telemetry and nothing reached the user: the card just sat there. Both payloads below
are verbatim from live traffic on 2026-08-07 05:20-05:21, where two turns took 15.7s and >50s for
exactly this reason and the near-miss ledger recorded zero.
"""

import inspect
from typing import Any, Dict, List

from backend.apps.agents.core import flight_recorder
from backend.apps.agents.manager.run import TurnRunner
from backend.apps.agents.manager.streaming.note_provider_retry import note_provider_retry, settle_provider_retries
from backend.apps.agents.manager.streaming.state import TurnState

# Verbatim SystemMessage.__dict__ from the live 500s.
LIVE_RETRY: Dict[str, Any] = {
    "subtype": "api_retry",
    "data": {
        "type": "system",
        "subtype": "api_retry",
        "attempt": 1,
        "max_retries": 10,
        "retry_delay_ms": 30000,
        "error_status": 500,
        "error": "server_error",
        "session_id": "2b0f3e16-8a38-4ae4-b1e9-70da2353b5d4",
        "uuid": "0cc6ec4a-6ead-4f3a-a29b-a5ceac2a4d2e",
    },
}


def test_the_live_500_becomes_a_breadcrumb_with_its_status_and_backoff():
    sid = "provretry01"
    flight_recorder.drop_session(sid)
    turn = TurnState()
    note_provider_retry(sid, LIVE_RETRY, turn)
    crumbs = [c for c in flight_recorder.breadcrumbs(sid) if c.get("l") == "provider-retry"]
    assert len(crumbs) == 1, "the retry must leave a trace a stranger can read"
    assert crumbs[0]["status"] == 500
    assert crumbs[0]["delay_ms"] == 30000, "the backoff is the whole reason the user saw a long silence"
    assert turn.provider_retries == 1
    assert turn.provider_retry_wait_ms == 30000
    flight_recorder.drop_session(sid)


def test_a_turn_that_survives_retries_lands_in_the_near_miss_ledger():
    sid = "provretry02"
    flight_recorder.drop_session(sid)
    sent: List[Dict[str, Any]] = []
    import backend.apps.service.client as service_client
    original = service_client.submit_diagnostic
    service_client.submit_diagnostic = lambda payload: sent.append(payload)
    try:
        turn = TurnState()
        note_provider_retry(sid, LIVE_RETRY, turn)
        note_provider_retry(sid, LIVE_RETRY, turn)
        settle_provider_retries(sid, turn, "sonnet-cc", {})
    finally:
        service_client.submit_diagnostic = original
    assert len(sent) == 1, "one settle per turn, not one per retry"
    assert sent[0]["kind"] == "recovered"
    assert sent[0]["subkind"] == "provider-retry"
    assert sent[0]["attempts"] == 2, "the denominator has to count every retry the turn rode out"
    flight_recorder.drop_session(sid)


def test_a_turn_with_no_retries_stays_out_of_the_ledger():
    sid = "provretry03"
    sent: List[Dict[str, Any]] = []
    import backend.apps.service.client as service_client
    original = service_client.submit_diagnostic
    service_client.submit_diagnostic = lambda payload: sent.append(payload)
    try:
        settle_provider_retries(sid, TurnState(), "sonnet-cc", {})
    finally:
        service_client.submit_diagnostic = original
    assert sent == [], "a clean turn must not inflate the near-miss count"


def test_a_malformed_retry_event_never_breaks_the_turn():
    sid = "provretry04"
    flight_recorder.drop_session(sid)
    turn = TurnState()
    for junk in ("not a dict", {"subtype": "api_retry"}, {"subtype": "api_retry", "data": None}):
        note_provider_retry(sid, junk, turn)
    flight_recorder.drop_session(sid)


def test_the_turn_loop_actually_dispatches_api_retry():
    src = inspect.getsource(TurnRunner)
    assert 'p_subtype == "api_retry"' in src, "the SystemMessage branch must recognise the retry subtype"
    assert "note_provider_retry(session_id, raw, turn)" in src
    assert "settle_provider_retries(session_id, turn, resolved_model, self.sessions)" in src


def test_the_kind_names_what_the_cli_waits_on():
    """Fleet, 7 days to 2026-09-07: 121 of 245 retries carried no status (our router down or restarting), 98 the
    router's own 502 for an upstream it could not reach, 13 a 429. "Provider busy" covered all three."""
    from backend.apps.agents.manager.streaming.note_provider_retry import retry_kind
    assert retry_kind(None, "unknown") == "unreachable"
    assert retry_kind(502, "server_error") == "provider_error"
    assert retry_kind(503, "server_error") == "provider_error"
    assert retry_kind(429, "rate_limit") == "rate_limit"
    assert retry_kind(401, "authentication_failed") == "auth"
    assert retry_kind(400, "invalid_request") == "other"


def test_the_kind_rides_the_crumb_the_wire_and_the_recovered_envelope(monkeypatch):
    import asyncio
    from backend.apps.agents.core import ws_manager as wsm
    sid = "provretry05"
    flight_recorder.drop_session(sid)
    sent_ws: List[Dict[str, Any]] = []

    async def fake_send(session_id: str, event: str, payload: Dict[str, Any]) -> None:
        sent_ws.append({"event": event, **payload})

    monkeypatch.setattr(wsm.ws_manager, "send_to_session", fake_send)
    sent: List[Dict[str, Any]] = []
    import backend.apps.service.client as service_client
    monkeypatch.setattr(service_client, "submit_diagnostic", lambda payload: sent.append(payload))

    async def run() -> None:
        turn = TurnState()
        note_provider_retry(sid, LIVE_RETRY, turn)
        note_provider_retry(sid, {"subtype": "api_retry", "data": {"attempt": 2, "retry_delay_ms": 29000, "error_status": None, "error": "unknown"}}, turn)
        await asyncio.sleep(0)
        settle_provider_retries(sid, turn, "gpt-5.6", {})

    asyncio.run(run())
    crumbs = [c for c in flight_recorder.breadcrumbs(sid) if c.get("l") == "provider-retry"]
    assert [c["kind"] for c in crumbs] == ["provider_error", "unreachable"]
    assert [w["kind"] for w in sent_ws if w["event"] == "agent:provider_retrying"] == ["provider_error", "unreachable"]
    assert sent[0]["retry_kinds"] == {"provider_error": 1, "unreachable": 1}, "the recovered envelope finally says what was retried"
    flight_recorder.drop_session(sid)
