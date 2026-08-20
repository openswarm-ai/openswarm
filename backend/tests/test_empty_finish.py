"""The silent-quit seal: a turn that runs tools and ends with no visible answer gets a hidden
continue nudge. Re-nudges must be EARNED by new tool work (the model is working but mute); a
stalled continuation surfaces honestly, and a hard cap bounds the worst case. Detector shapes
pinned here; the loop wiring is pinned against run_agent_loop."""

import asyncio

from backend.apps.agents.agent_manager import agent_manager
import backend.apps.agents.agent_manager as agent_manager_module
from backend.apps.agents.core.models import AgentSession, Message
from backend.apps.agents.manager.run.empty_finish import (
    FINAL_NUDGE_PROMPT,
    NUDGE_HARD_CAP,
    NUDGE_PROMPT,
    maybe_nudge_empty_finish,
    turn_finished_empty,
)


def p_session(*msgs) -> AgentSession:
    s = AgentSession(name="t", model="sonnet")
    for role, content in msgs:
        s.messages.append(Message(role=role, content=content, branch_id="main"))
    return s


def test_tool_result_tail_is_an_empty_finish():
    s = p_session(("user", "audit the repo"),
                  ("tool_call", {"tool": "Bash", "input": {"command": "ls"}}),
                  ("tool_result", {"text": "ok"}))
    assert turn_finished_empty(s) is True


def test_final_answer_text_is_not_empty():
    s = p_session(("user", "audit"),
                  ("tool_call", {"tool": "Bash", "input": {}}),
                  ("tool_result", {"text": "ok"}),
                  ("assistant", "Here is the audit report."))
    assert turn_finished_empty(s) is False


def test_empty_assistant_text_is_an_empty_finish():
    s = p_session(("user", "audit"), ("assistant", ""))
    assert turn_finished_empty(s) is True


def test_ui_answer_tools_are_a_legit_finish():
    s = p_session(("user", "show me"),
                  ("tool_call", {"tool": "mcp__openswarm-core__ShowUI", "input": {}}),
                  ("tool_result", {"text": "rendered"}))
    assert turn_finished_empty(s) is False


def test_plain_chat_answer_is_not_empty():
    s = p_session(("user", "hi"), ("assistant", "Hey! What can I do for you?"))
    assert turn_finished_empty(s) is False


def test_bare_user_prompt_is_not_claimed():
    s = p_session(("user", "hi"))
    assert turn_finished_empty(s) is False


def p_install_run_fakes(monkeypatch, run_turn_fake) -> None:
    async def fake_build(session, session_id, prompt, prompt_content, builtin_perms,
                         selected_browser_ids, selected_app_output_ids, selected_setting_ids,
                         fork_session, router_model_id, api_type):
        from backend.apps.settings.settings import load_settings
        return object(), {}, prompt_content, [], load_settings()

    monkeypatch.setattr(agent_manager, "build_agent_options", fake_build)
    monkeypatch.setattr(agent_manager, "run_turn_with_retry", run_turn_fake)
    monkeypatch.setattr(agent_manager_module, "save_session", lambda sid, data: None)


def test_loop_renudges_while_progressing_then_caps(monkeypatch) -> None:
    session = AgentSession(name="t", model="sonnet", dashboard_id="d")
    agent_manager.sessions[session.id] = session
    continues: list = []

    async def fake_run_turn(sess, session_id, prompt_content, options, options_kwargs,
                            turn, thinking, stderr, resolved_model, api_type,
                            global_settings, force_respawn=False):
        # Every turn ends as a silent quit: NEW tool work ran, no answer text.
        sess.messages.append(Message(role="tool_call", content={"tool": "Bash", "input": {}}, branch_id="main"))
        sess.messages.append(Message(role="tool_result", content={"text": "out"}, branch_id="main"))

    async def fake_send_message(session_id, prompt, hidden=False, **kwargs):
        continues.append({"prompt": prompt, "hidden": hidden})

    p_install_run_fakes(monkeypatch, fake_run_turn)
    monkeypatch.setattr(agent_manager, "send_message", fake_send_message)

    async def main():
        await agent_manager.run_agent_loop(session.id, "audit everything")
        await asyncio.sleep(0)

    # Each silent quit made fresh tool progress, so each earns a nudge, up to the hard cap;
    # the LAST one escalates to the text-only demand (field data: "continue" just bought more
    # silent tool work, so the closer must extract an answer, not more work).
    for expected in range(1, NUDGE_HARD_CAP + 1):
        continues.clear()
        asyncio.run(main())
        want = FINAL_NUDGE_PROMPT if expected == NUDGE_HARD_CAP else NUDGE_PROMPT
        assert continues == [{"prompt": want, "hidden": True}]
        assert session.empty_finish_nudges == expected

    # At the cap even a progressing silent quit surfaces honestly: no nudge, one system line.
    continues.clear()
    asyncio.run(main())
    assert continues == []
    assert session.empty_finish_nudges == NUDGE_HARD_CAP
    p_sys = [m for m in session.messages if m.role == "system" and "without a final report" in str(m.content)]
    assert len(p_sys) == 1, "exhaustion surfaces exactly once"
    # A second exhausted quit in the same ask must NOT stack another line.
    asyncio.run(main())
    p_sys = [m for m in session.messages if m.role == "system" and "without a final report" in str(m.content)]
    assert len(p_sys) == 1


def test_stalled_continuation_is_not_renudged() -> None:
    s = p_session(("user", "audit"),
                  ("tool_call", {"tool": "Bash", "input": {}}),
                  ("tool_result", {"text": "ok"}))
    assert maybe_nudge_empty_finish(s, "sid") is True
    assert s.empty_finish_nudges == 1
    # The continuation dispatched, added NOTHING, and quit silently again: no second nudge.
    s.pending_continuation = False
    assert maybe_nudge_empty_finish(s, "sid") is False
    assert s.empty_finish_nudges == 1
    # New tool work arrives: the re-nudge is earned again.
    s.messages.append(Message(role="tool_call", content={"tool": "Grep", "input": {}}, branch_id="main"))
    s.messages.append(Message(role="tool_result", content={"text": "hit"}, branch_id="main"))
    s.pending_continuation = False
    assert maybe_nudge_empty_finish(s, "sid") is True
    assert s.empty_finish_nudges == 2


def test_high_context_empty_finish_compacts_before_nudge():
    """ENG-354: a silent quit at high context must compact + go fresh, not just re-send the bloat."""
    from backend.apps.agents.manager.run.empty_finish import maybe_nudge_empty_finish
    s = p_session(("user", "long task"),
                  ("tool_call", {"tool": "Bash", "input": {"command": "ls"}}),
                  ("tool_result", {"text": "ok"}),
                  ("tool_call", {"tool": "Bash", "input": {"command": "pwd"}}),
                  ("tool_result", {"text": "/tmp"}),
                  ("tool_call", {"tool": "Bash", "input": {"command": "date"}}),
                  ("tool_result", {"text": "now"}))
    s.context_window = 200_000
    s.tokens["input"] = 190_000
    assert maybe_nudge_empty_finish(s, "sid-high") is True
    assert s.compacted_through_msg_id is not None
    assert s.needs_fresh_session is True


def test_low_context_empty_finish_nudges_without_compacting():
    from backend.apps.agents.manager.run.empty_finish import maybe_nudge_empty_finish
    s = p_session(("user", "small task"),
                  ("tool_call", {"tool": "Bash", "input": {"command": "ls"}}),
                  ("tool_result", {"text": "ok"}))
    s.context_window = 1_000_000
    s.tokens["input"] = 30_000
    assert maybe_nudge_empty_finish(s, "sid-low") is True
    assert s.compacted_through_msg_id is None
    assert getattr(s, "needs_fresh_session", False) is False


def test_repeat_quit_compacts_from_the_low_floor():
    """ENG-354 field data: opus-5 quits at ~149K, BELOW the 180K trigger; a repeat quit must compact anyway."""
    from backend.apps.agents.manager.run.empty_finish import maybe_nudge_empty_finish
    s = p_session(("user", "long task"),
                  ("tool_call", {"tool": "Read", "input": {"file_path": "/a"}}),
                  ("tool_result", {"text": "x"}),
                  ("tool_call", {"tool": "Read", "input": {"file_path": "/b"}}),
                  ("tool_result", {"text": "y"}),
                  ("tool_call", {"tool": "Read", "input": {"file_path": "/c"}}),
                  ("tool_result", {"text": "z"}))
    s.context_window = 1_000_000
    s.tokens["input"] = 100_000  # below the 144K first-quit floor, above the 72K repeat floor
    assert maybe_nudge_empty_finish(s, "sid-r1") is True
    assert s.compacted_through_msg_id is None, "first quit below the band must NOT compact"
    # New user message resets the per-message counter but not the lifetime one; the loop consumed the pending continuation.
    s.pending_continuation = False
    s.empty_finish_nudges = 0
    s.empty_finish_progress_mark = 0
    assert maybe_nudge_empty_finish(s, "sid-r2") is True
    assert s.compacted_through_msg_id is not None, "repeat quit must compact from the low floor"
    assert s.needs_fresh_session is True


def test_drill_seam_disables_compaction(monkeypatch):
    from backend.apps.agents.manager.run.empty_finish import maybe_nudge_empty_finish
    monkeypatch.setenv("OSW_DISABLE_EMPTY_FINISH_COMPACT", "1")
    s = p_session(("user", "t"),
                  ("tool_call", {"tool": "Read", "input": {}}),
                  ("tool_result", {"text": "x"}),
                  ("tool_call", {"tool": "Read", "input": {}}),
                  ("tool_result", {"text": "y"}),
                  ("tool_call", {"tool": "Read", "input": {}}),
                  ("tool_result", {"text": "z"}))
    s.context_window = 1_000_000
    s.tokens["input"] = 190_000
    assert maybe_nudge_empty_finish(s, "sid-seam") is True
    assert s.compacted_through_msg_id is None


def test_vanishing_quit_on_repeat_session_is_claimed():
    """Haik's poke storm: 'continue' -> instant thinking-only quit -> NOTHING persisted. A session
    that already silent-quit must claim that vanishing act; a truly bare first prompt stays unclaimed."""
    from backend.apps.agents.manager.run.empty_finish import turn_finished_empty
    s = p_session(("user", "task"),
                  ("tool_call", {"tool": "Read", "input": {}}),
                  ("tool_result", {"text": "x"}),
                  ("user", "you stopped. continue."))
    assert turn_finished_empty(s) is False, "first-time session: user tail stays unclaimed"
    s.empty_finish_total = 1
    assert turn_finished_empty(s) is True, "repeat session: the vanishing quit is claimed"


def p_system_lines(session) -> list:
    return [m for m in session.messages if m.role == "system"]


def test_stalled_continuation_still_tells_the_user() -> None:
    """The anti-ping-pong guard is right to refuse a second nudge, but the ask must not end in
    silence: that Done-pill-over-tool-rows is exactly what users report as 'it just stopped'
    (drill D3/C4, 2026-08-20)."""
    s = p_session(("user", "audit the repo"),
                  ("tool_call", {"tool": "Bash", "input": {}}),
                  ("tool_result", {"text": "ok"}))
    assert maybe_nudge_empty_finish(s, "sid") is True
    s.pending_continuation = False
    # The nudge bought nothing at all.
    assert maybe_nudge_empty_finish(s, "sid") is False
    assert s.empty_finish_nudges == 1, "still no second nudge"
    assert len(p_system_lines(s)) == 1, "but the user is told once"

    # And it stays once, however many stalled quits follow.
    s.pending_continuation = False
    assert maybe_nudge_empty_finish(s, "sid") is False
    assert len(p_system_lines(s)) == 1


def test_turn_that_produced_nothing_is_not_silent() -> None:
    """No text, no tool call, nothing persisted: the tail-walk cannot see it, so the honest line
    is the only thing standing between the user and an empty Done pill (drill D4/C3/C5)."""
    s = p_session(("user", "read all 16 files and report the magic word"))
    assert maybe_nudge_empty_finish(s, "sid") is False, "nudging would re-send a refused prompt"
    assert len(p_system_lines(s)) == 1, "the user gets an honest line instead of silence"


def test_a_working_turn_is_never_given_the_exhausted_line() -> None:
    """Negative control: a turn that actually answered must stay clean."""
    s = p_session(("user", "hi"), ("assistant", "here is your answer"))
    assert maybe_nudge_empty_finish(s, "sid") is False
    assert p_system_lines(s) == [], "an answered turn earns no card"


def test_a_turn_still_holding_tool_work_is_not_called_empty_handed() -> None:
    """Negative control for the produced-nothing seal: tool work exists, so this is the ordinary
    nudge path, not the empty-handed one."""
    s = p_session(("user", "task"),
                  ("tool_call", {"tool": "Read", "input": {}}),
                  ("tool_result", {"text": "x"}))
    assert maybe_nudge_empty_finish(s, "sid") is True, "ordinary silent quit still nudges"
    assert p_system_lines(s) == [], "and says nothing yet, because work may still land"


def test_the_honest_lines_survive_the_frontends_jargon_filter() -> None:
    """The seal only works if the user can SEE the line. MessageBubble.tsx deliberately swallows
    raw subprocess/API dumps rendered as system messages, so an honest note that happens to match
    those patterns would be added by the backend and then silently dropped by the UI: the exact
    silence this whole issue is about, just moved one layer up. Kept here rather than in a .tsx
    test so it lives beside the text it guards and cannot drift from it."""
    import re
    from backend.apps.agents.manager.run.empty_finish import EXHAUSTED_NOTE

    # Mirrors the swallow test in frontend/src/app/pages/AgentChat/bubbles/MessageBubble.tsx.
    p_swallowed = re.compile(
        r'Command failed with exit code|API Error:|invalid_request_error'
        r'|"type"\s*:\s*"error"|Check stderr output',
        re.IGNORECASE,
    )
    assert not p_swallowed.search(EXHAUSTED_NOTE), (
        "the exhausted note would be swallowed by the UI's dev-jargon filter"
    )
    assert EXHAUSTED_NOTE.strip(), "an empty note renders as nothing at all"
