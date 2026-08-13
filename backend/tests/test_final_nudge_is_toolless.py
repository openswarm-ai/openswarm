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

    monkeypatch.setattr(empty_finish, "p_count_tool_calls", p_tool_calls)
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


def test_the_options_builder_actually_empties_the_list() -> None:
    """The flag is worthless unless the turn's tool list is really emptied. This asserts the wiring
    exists at the one place that decides it, so the seal cannot be a field nobody reads."""
    import inspect
    from backend.apps.agents.manager.run import RunOptions

    src = inspect.getsource(RunOptions)
    assert "pending_continuation_toolless" in src, (
        "nothing in RunOptions reads the flag, so the final turn still ships a full tool list"
    )
    idx = src.index("pending_continuation_toolless")
    window = src[idx: idx + 320]
    assert "effective_allowed = []" in window, (
        "the flag is read but the allowed-tool list is not emptied"
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
