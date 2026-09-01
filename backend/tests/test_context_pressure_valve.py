"""Context-pressure valve invariant.

The bug class (1.5.4 field reports): an oversized/incompressible context makes
the CLI's autocompact churn until its own thrash detector gives up and the
process dies with a bare exit-1 ProcessError; the user got a cryptic error card
and had to type "continue".

The seal: run_agent_loop detects that death shape structurally (2+ CLI
compact_boundary events this turn + a ProcessError no other classifier claims)
and transparently re-runs the turn ONCE through the proven fresh-session recap
path. Anything else keeps today's error handling, and the retry can never loop.
"""

import asyncio

from backend.apps.agents.agent_manager import agent_manager
import backend.apps.agents.agent_manager as agent_manager_module
from backend.apps.agents.core.error_classify import is_context_pressure_death
from backend.apps.agents.core.models import AgentSession


class ProcessError(Exception):
    pass


def test_predicate_claims_thrash_death() -> None:
    e = ProcessError("Command failed with exit code 1 (exit code: 1)\nError output: Check stderr output for details")
    assert is_context_pressure_death(e, 1) is True
    assert is_context_pressure_death(e, 3) is True


def test_predicate_needs_compaction_this_turn() -> None:
    e = ProcessError("Command failed with exit code 1")
    assert is_context_pressure_death(e, 0) is False


def test_predicate_needs_a_process_death() -> None:
    assert is_context_pressure_death(ValueError("Command failed with exit code 1"), 3) is False


def test_predicate_defers_to_specific_classifiers() -> None:
    assert is_context_pressure_death(ProcessError("529 overloaded, try again shortly"), 3) is False
    assert is_context_pressure_death(ProcessError("credit balance is too low"), 3) is False
    assert is_context_pressure_death(ProcessError("Command failed with exit code 1"), 3, extra_text="401 authentication_error: invalid x-api-key") is False


def p_seed_session() -> AgentSession:
    session = AgentSession(name="t", model="sonnet", dashboard_id="d")
    agent_manager.sessions[session.id] = session
    return session


def p_install_run_fakes(monkeypatch, run_turn_fake) -> None:
    async def fake_build(session, session_id, prompt, prompt_content, builtin_perms,
                         selected_browser_ids, selected_app_output_ids, selected_setting_ids,
                         fork_session, router_model_id, api_type):
        from backend.apps.settings.settings import load_settings
        return object(), {}, prompt_content, [], load_settings()

    monkeypatch.setattr(agent_manager, "build_agent_options", fake_build)
    monkeypatch.setattr(agent_manager, "run_turn_with_retry", run_turn_fake)
    monkeypatch.setattr(agent_manager_module, "save_session", lambda sid, data: None)


def p_capture_status(monkeypatch) -> list:
    """Record the status the UI actually receives, not just the one left on the object."""
    from backend.apps.agents.core.ws_manager import ws_manager
    seen: list = []

    async def fake_send(session_id, event, data):
        if event == "agent:status":
            seen.append(data.get("status"))

    monkeypatch.setattr(ws_manager, "send_to_session", fake_send)
    return seen


def test_valve_retries_once_through_fresh_path(monkeypatch) -> None:
    session = p_seed_session()
    calls: list = []

    async def fake_run_turn(sess, session_id, prompt_content, options, options_kwargs,
                            turn, thinking, stderr, resolved_model, api_type,
                            global_settings, force_respawn=False):
        calls.append({"force_respawn": force_respawn, "needs_fresh": sess.needs_fresh_session})
        if len(calls) == 1:
            turn.compact_boundaries = 3
            raise ProcessError("Command failed with exit code 1 (exit code: 1)")

    p_install_run_fakes(monkeypatch, fake_run_turn)
    asyncio.run(agent_manager.run_agent_loop(session.id, "hello"))

    assert len(calls) == 2
    assert calls[1]["force_respawn"] is True
    assert calls[1]["needs_fresh"] is True
    assert session.status == "completed"
    assert not [m for m in session.messages if m.role == "system" and str(m.content).startswith("Error:")]


def test_no_valve_without_compaction_churn(monkeypatch) -> None:
    session = p_seed_session()
    calls: list = []

    async def fake_run_turn(sess, session_id, prompt_content, options, options_kwargs,
                            turn, thinking, stderr, resolved_model, api_type,
                            global_settings, force_respawn=False):
        calls.append(1)
        raise ProcessError("Command failed with exit code 1 (exit code: 1)")

    p_install_run_fakes(monkeypatch, fake_run_turn)
    asyncio.run(agent_manager.run_agent_loop(session.id, "hello"))

    assert len(calls) == 1
    assert session.status == "error"
    assert [m for m in session.messages if m.role == "system" and str(m.content).startswith("Error:")]


def test_overflow_valve_retries_with_forced_compaction(monkeypatch) -> None:
    from backend.apps.agents.core.models import Message
    from backend.apps.agents.manager.streaming.handle_result_message import TurnResultError
    session = p_seed_session()
    # Enough history that the forced compact mark has something to cut (keeps last 6).
    for i in range(10):
        session.messages.append(Message(role="user" if i % 2 == 0 else "assistant", content=f"m{i}", branch_id=session.active_branch_id))
    calls: list = []

    async def fake_run_turn(sess, session_id, prompt_content, options, options_kwargs,
                            turn, thinking, stderr, resolved_model, api_type,
                            global_settings, force_respawn=False):
        calls.append({"needs_fresh": sess.needs_fresh_session})
        # Zero compact boundaries on purpose: an overflow can hit before autocompact ever fired.
        if len(calls) == 1:
            raise TurnResultError("Prompt is too long")

    p_install_run_fakes(monkeypatch, fake_run_turn)
    asyncio.run(agent_manager.run_agent_loop(session.id, "hello"))

    assert len(calls) == 2
    assert calls[1]["needs_fresh"] is True
    assert session.compacted_through_msg_id is not None
    assert session.status == "completed"
    assert not [m for m in session.messages if m.role == "system" and str(m.content).startswith("Error:")]


def test_overflow_on_retry_surfaces_the_card_not_a_fake_completed(monkeypatch) -> None:
    session = p_seed_session()
    calls: list = []

    async def fake_run_turn(sess, session_id, prompt_content, options, options_kwargs,
                            turn, thinking, stderr, resolved_model, api_type,
                            global_settings, force_respawn=False):
        calls.append(1)
        # Fake mid-task streaming: the old handle_run_error early-return keyed on exactly this and marked the dead run "completed".
        turn.stream_text_msg_id = "msg-1"
        turn.current_turn_emitted = True
        raise Exception("Error code: 429 - extra usage is required for long context")

    p_install_run_fakes(monkeypatch, fake_run_turn)
    asyncio.run(agent_manager.run_agent_loop(session.id, "hello"))

    assert len(calls) == 2
    assert session.status == "error"
    assert [m for m in session.messages if m.role == "system" and "context window" in str(m.content)]


def test_valve_never_loops(monkeypatch) -> None:
    session = p_seed_session()
    calls: list = []

    async def fake_run_turn(sess, session_id, prompt_content, options, options_kwargs,
                            turn, thinking, stderr, resolved_model, api_type,
                            global_settings, force_respawn=False):
        calls.append(1)
        turn.compact_boundaries = 3
        raise ProcessError("Command failed with exit code 1 (exit code: 1)")

    p_install_run_fakes(monkeypatch, fake_run_turn)
    asyncio.run(agent_manager.run_agent_loop(session.id, "hello"))

    assert len(calls) == 2
    assert session.status == "error"
    # The second death used to fall through to the raw "Error: ..." blob. It is now owned by the
    # autocompact-thrash card (handle_run_error), which names the conversation as the cause and
    # rules out switching models. Either way the invariant this test exists for holds: exactly one
    # retry, then a terminal card, never a third attempt.
    cards = [m for m in session.messages if m.role == "system"]
    assert cards, "the exhausted valve must leave a card, not silence"
    low = str(cards[-1].content).lower()
    assert "fresh chat" in low, "the honest thrash card, not the raw blob"
    assert "switching models will not help" in low


def test_midturn_break_completes_and_fires_the_hidden_continuation(monkeypatch) -> None:
    from backend.apps.agents.manager.context_budget import CONTINUATION_PROMPT
    session = p_seed_session()
    continues: list = []

    async def fake_run_turn(sess, session_id, prompt_content, options, options_kwargs,
                            turn, thinking, stderr, resolved_model, api_type,
                            global_settings, force_respawn=False):
        # Simulate maybe_break_midturn firing inside the stream loop: flags set, turn returns at the boundary.
        turn.context_break_fired = True
        sess.needs_fresh_session = True
        sess.pending_continuation = True
        sess.pending_continuation_prompt = CONTINUATION_PROMPT

    async def fake_send_message(session_id, prompt, hidden=False, **kwargs):
        continues.append({"prompt": prompt, "hidden": hidden})

    p_install_run_fakes(monkeypatch, fake_run_turn)
    monkeypatch.setattr(agent_manager, "send_message", fake_send_message)
    statuses = p_capture_status(monkeypatch)

    async def main():
        await agent_manager.run_agent_loop(session.id, "audit everything")
        await asyncio.sleep(0)

    asyncio.run(main())
    # The card must never read Done while the harness is committed to continuing: that is what made
    # a field user type "hello?" into a chat that was still working.
    assert "completed" not in statuses, f"told the UI a continuing turn had finished: {statuses}"
    assert session.status == "running"
    assert session.needs_fresh_session is True
    assert session.pending_continuation is False
    assert continues == [{"prompt": CONTINUATION_PROMPT, "hidden": True}]


def test_a_continuation_that_never_starts_releases_the_running_status(monkeypatch) -> None:
    """The other direction: "running" is a promise that a turn follows. If the continuation never
    becomes one, the promise is released, or the card spins forever on a session with no task."""
    from backend.apps.agents.manager.context_budget import CONTINUATION_PROMPT
    session = p_seed_session()
    statuses = p_capture_status(monkeypatch)

    async def fake_run_turn(sess, session_id, prompt_content, options, options_kwargs,
                            turn, thinking, stderr, resolved_model, api_type,
                            global_settings, force_respawn=False):
        turn.context_break_fired = True
        sess.needs_fresh_session = True
        sess.pending_continuation = True
        sess.pending_continuation_prompt = CONTINUATION_PROMPT

    async def exploding_send_message(session_id, prompt, hidden=False, **kwargs):
        raise RuntimeError("CLI never came up")

    p_install_run_fakes(monkeypatch, fake_run_turn)
    monkeypatch.setattr(agent_manager, "send_message", exploding_send_message)

    async def main():
        await agent_manager.run_agent_loop(session.id, "audit everything")
        await asyncio.sleep(0)

    asyncio.run(main())
    assert session.status == "completed"
    assert statuses[-1] == "completed"
