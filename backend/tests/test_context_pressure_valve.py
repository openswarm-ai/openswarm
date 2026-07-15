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
    assert [m for m in session.messages if m.role == "system" and str(m.content).startswith("Error:")]
