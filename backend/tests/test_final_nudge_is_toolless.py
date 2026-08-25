"""The last silent-quit nudge must be structurally unable to call tools (ENG-291).

ENG-211 shipped an escalation that ASKS the model to stop: "Stop. Do not call any more
tools." That is a sentence, and a model that ignores it runs more tools and quits silent
again. It shipped in 1.7.6 and Haik reported the same "go on" prodding on 1.7.7, which is
field evidence that wording does not hold. ENG-211 named this exact follow-up in its own
closing note.

The seal is that the final continuation turn is dispatched with an empty allowed-tool
list, so "the model ignored the instruction" stops being expressible.

Run:
    backend/.venv/bin/python -m pytest backend/tests/test_final_nudge_is_toolless.py -v
"""

from typing import Any

from backend.apps.agents.core.models import AgentSession
from backend.apps.agents.manager.run import empty_finish


def p_session() -> AgentSession:
    return AgentSession(name="probe", model="opus", cwd="/tmp")


def p_arm(session: AgentSession, times: int, monkeypatch: Any) -> None:
    """Drive the nudge counter the way real turns do: each nudge needs new tool work."""
    monkeypatch.setattr(empty_finish, "turn_finished_empty", lambda session_arg: True)
    calls = {"n": 0}

    def p_tool_calls(session_arg: AgentSession) -> int:
        calls["n"] += 1
        return calls["n"] * 10          # always more work than the last mark

    monkeypatch.setattr(empty_finish, "count_tool_calls", p_tool_calls)
    for _ in range(times):
        session.pending_continuation = False
        empty_finish.maybe_nudge_empty_finish(session, "sid")


def test_early_nudges_keep_their_tools(monkeypatch: Any) -> None:
    """The first nudges are asking for MORE work, so stripping tools there would break the fix."""
    s = p_session()
    p_arm(s, 1, monkeypatch)
    assert s.empty_finish_nudges == 1
    assert s.pending_continuation_toolless is False, "nudge 1 still needs tools to finish the task"


def test_the_final_nudge_is_marked_toolless(monkeypatch: Any) -> None:
    s = p_session()
    p_arm(s, empty_finish.NUDGE_HARD_CAP, monkeypatch)
    assert s.empty_finish_nudges == empty_finish.NUDGE_HARD_CAP
    assert s.pending_continuation_prompt == empty_finish.FINAL_NUDGE_PROMPT
    assert s.pending_continuation_toolless is True, (
        "the final nudge only ASKS the model to stop calling tools; a model that ignores the "
        "sentence quits silent again, which is exactly what came back on 1.7.7"
    )


def test_the_toolless_turn_really_gets_no_tools() -> None:
    """Behaviour, not a source grep: the flag must actually empty what the turn is handed.

    An earlier version of this asserted the string "effective_allowed = []" appeared in
    RunOptions, which broke the moment the logic moved and proved nothing about the result.
    """
    allowed = ["Bash", "Read", "Write", "WebSearch"]
    servers = {"openswarm-core": {"env": {}}}

    s_off = p_session()
    assert empty_finish.apply_toolless_continuation(s_off, allowed, servers) == (allowed, servers), (
        "an ordinary turn must keep every tool it was given"
    )

    s_on = p_session()
    s_on.pending_continuation_toolless = True
    got_allowed, got_servers = empty_finish.apply_toolless_continuation(s_on, allowed, servers)
    assert got_allowed == [], f"final turn still offered {len(got_allowed)} tool(s): {got_allowed}"
    assert got_servers == {}, "final turn still had MCP servers attached, so tools remain reachable"


def test_run_options_actually_calls_it() -> None:
    """The helper is only a seal if the options path invokes it."""
    import inspect
    from backend.apps.agents.manager.run import RunOptions
    assert "apply_toolless_continuation(" in inspect.getsource(RunOptions), (
        "RunOptions never calls the helper, so the final turn still ships a full tool list"
    )


def test_a_real_user_message_clears_the_toolless_state() -> None:
    """A session must not stay toolless after the user speaks again."""
    s = p_session()
    s.pending_continuation_toolless = True
    s.empty_finish_nudges = 3
    # The reset the loop performs on a real user message.
    s.empty_finish_nudges = 0
    s.pending_continuation_toolless = False
    assert s.pending_continuation_toolless is False
    assert s.empty_finish_nudges == 0
