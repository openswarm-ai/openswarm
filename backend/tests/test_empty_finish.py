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
