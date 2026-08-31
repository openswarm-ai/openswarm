"""Drive handle_run_error's out-of-credits branch. The is_out_of_tokens / extract_reset_hint
helpers were built but never wired in, so a provider credit/quota error fell through to the
raw-error blob; this pins the friendly card + agent:out_of_credits event (and the reset hint)."""

import asyncio

import backend.apps.agents.core.ws_manager as ws_mod
from backend.apps.agents.core.models import AgentSession
from backend.apps.agents.manager.run.handle_run_error import handle_run_error
from backend.apps.agents.manager.streaming.state import TurnState


def p_drive_error(monkeypatch, exc, stderr=None, session=None):
    events = []

    async def fake_send(session_id, event, data):
        events.append((event, data))

    monkeypatch.setattr(ws_mod.ws_manager, "send_to_session", fake_send, raising=True)
    # Diagnostics are fire-and-forget network; keep the tests offline.
    import backend.apps.service.client as service_client
    monkeypatch.setattr(service_client, "submit_diagnostic", lambda payload: None, raising=True)
    # Passing a session back in drives a SECOND failure on the same ask, which is the only way to
    # test a once-per-ask budget: a fresh session would silently hand it a fresh budget too.
    if session is None:
        session = AgentSession(name="t", model="sonnet", dashboard_id="d")
    asyncio.run(handle_run_error(exc, session, session.id, TurnState(), stderr or []))
    return session, events


def test_out_of_credits_shows_friendly_card_not_raw_error(monkeypatch):
    session, events = p_drive_error(
        monkeypatch, Exception("Your credit balance is too low to run this request")
    )
    assert session.status == "error"
    assert "agent:out_of_credits" in [e for e, _ in events]
    sys_msgs = [m for m in session.messages if m.role == "system"]
    assert sys_msgs, "expected a system card"
    assert "out of credits or over your usage limit" in sys_msgs[-1].content
    assert not sys_msgs[-1].content.startswith("Error:")  # not the raw-error fallthrough


def test_out_of_credits_carries_the_provider_reset_hint(monkeypatch):
    _, events = p_drive_error(
        monkeypatch, Exception("insufficient_quota; resets at 7:42 AM")
    )
    payload = next(d for e, d in events if e == "agent:out_of_credits")
    assert payload["reset_hint"] == "at 7:42 AM"
    assert "resets at 7:42 AM" in payload["message"]


P_FIELD_CLI_MISSING = (
    "Claude Code not found at: C:\\Users\\Rishi\\AppData\\Local\\openswarm\\app-1.5.6\\resources"
    "\\python-env\\Lib\\site-packages\\claude_agent_sdk\\_bundled\\claude.exe"
)


def test_cli_missing_shows_repair_card_not_dead_path(monkeypatch):
    session, events = p_drive_error(monkeypatch, Exception(P_FIELD_CLI_MISSING))
    assert session.status == "error"
    sys_msgs = [m for m in session.messages if m.role == "system"]
    assert sys_msgs, "expected a system card"
    card = sys_msgs[-1].content
    # Case-folded: the card opens its second sentence with "Antivirus", and a capital letter is not
    # a behaviour change. This assertion was checking the copy's punctuation, not its meaning.
    low = card.lower()
    assert "antivirus" in low
    assert "reinstall" in low
    # The raw path dump is exactly the unactionable card we're replacing.
    assert "AppData" not in card


def test_unclassified_card_carries_scrubbed_stderr_tail(monkeypatch):
    exc = Exception(
        "Command failed with exit code 1 (exit code: 1)\nError output: Check stderr output for details"
    )
    # Neutral cause text: anything auth/capacity-shaped would (correctly) route to a friendlier branch instead.
    secret = "sk-" + "ant-" + "A" * 28
    stderr = ["boot noise", f"TypeError: cannot read properties of undefined (reading 'chunk') {secret}"]
    session, _ = p_drive_error(monkeypatch, exc, stderr=stderr)
    card = [m for m in session.messages if m.role == "system"][-1].content
    assert "Runtime log tail" in card
    assert "TypeError" in card
    assert secret not in card


def test_informative_error_does_not_get_stderr_appended(monkeypatch):
    exc = Exception("Something specific broke: widget frobnicator misconfigured")
    session, _ = p_drive_error(monkeypatch, exc, stderr=["irrelevant tail"])
    card = [m for m in session.messages if m.role == "system"][-1].content
    assert "Runtime log tail" not in card


# ENG-258: one session bricking on "hit a snag" forever while its siblings run fine. Every classified
# branch is an external fact a respawn can't fix; the unclassified bucket is the one that can be this
# session's own poisoned CLI state, replayed identically on every retry. Assert BOTH directions, or
# "it arms" would pass just as well on a version that arms unconditionally.

def test_unclassified_failure_arms_a_fresh_session_so_the_next_send_self_heals(monkeypatch):
    session, _ = p_drive_error(
        monkeypatch, Exception("API Error: 400 invalid_request_error: messages.3: unexpected block")
    )
    assert session.needs_fresh_session is True


def test_a_dead_resume_transcript_does_not_stay_sticky(monkeypatch):
    # The real shape of a session bricked by its own CLI state: the resume id no longer resolves, so
    # every retry replays the same doomed resume until something drops it.
    session, _ = p_drive_error(
        monkeypatch, Exception("No conversation found with session ID: 9f3c1a2b-dead-4f00-bbbb-000000000000")
    )
    assert session.needs_fresh_session is True


def test_out_of_credits_does_not_respawn_the_cli(monkeypatch):
    session, _ = p_drive_error(
        monkeypatch, Exception("Your credit balance is too low to run this request")
    )
    assert session.needs_fresh_session is False


def test_auth_failure_self_heals_once_then_stops_respawning(monkeypatch):
    # ENG-361 amended the older "never respawn on auth" rule: every sub lane now gets ONE silent
    # self-heal before any card, and a fresh CLI is exactly how the stale token gets dropped. The
    # rule that still matters is that it happens ONCE; a credential that fails twice is genuinely
    # dead, and respawning forever would just hide it behind an endless retry.
    session, _ = p_drive_error(monkeypatch, Exception("401 invalid authentication credentials"))
    assert session.needs_respawn is True, "one respawn on the same transcript is the heal"
    assert session.auth_retry_used is True
    assert not [m for m in session.messages if m.role == "system"], "no card on the first expiry"

    session.needs_respawn = False
    session.pending_continuation = False
    p_drive_error(monkeypatch, Exception("401 invalid authentication credentials"), session=session)
    assert session.needs_respawn is False, "the budget is spent; stop respawning"
    assert [m for m in session.messages if m.role == "system"], "the second failure is honest"


def test_missing_credential_never_burns_a_retry(monkeypatch):
    # Negative control: a config problem retries identically, so it must card immediately instead
    # of spending a rebuild and a wait on a request that cannot succeed.
    session, _ = p_drive_error(monkeypatch, Exception("No credentials for provider: claude (401)"))
    assert session.needs_fresh_session is False
    assert [m for m in session.messages if m.role == "system"], "straight to the honest card"


def test_rate_limit_does_not_respawn_the_cli(monkeypatch):
    session, _ = p_drive_error(monkeypatch, Exception("429 rate_limit_error: overloaded"))
    assert session.needs_fresh_session is False


def test_missing_cli_binary_does_not_respawn_the_cli(monkeypatch):
    session, _ = p_drive_error(monkeypatch, Exception(P_FIELD_CLI_MISSING))
    assert session.needs_fresh_session is False
