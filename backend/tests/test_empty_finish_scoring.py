"""ENG-364 pins: a structured final answer is an answer, and a real user message forgives the
session's silent-quit history (the repeat floor and the vanishing-quit rule key on it)."""

from backend.apps.agents.core.models import AgentSession, Message
from backend.apps.agents.manager.run.empty_finish import turn_finished_empty


def p_session(*msgs) -> AgentSession:
    s = AgentSession(name="t", model="sonnet")
    for role, content in msgs:
        s.messages.append(Message(role=role, content=content, branch_id="main"))
    return s


def test_structured_assistant_content_is_not_a_silent_quit():
    """ENG-364: a final answer written as content blocks used to score as "", i.e. as a quit."""
    s = p_session(("user", "audit"),
                  ("tool_call", {"tool": "Bash", "input": {}}),
                  ("tool_result", {"text": "ok"}),
                  ("assistant", [{"type": "text", "text": "Done: 3 findings."}]))
    assert turn_finished_empty(s) is False
    s2 = p_session(("user", "audit"),
                   ("tool_call", {"tool": "Bash", "input": {}}),
                   ("tool_result", {"text": "ok"}),
                   ("assistant", [{"type": "text", "text": "   "}]))
    assert turn_finished_empty(s2) is True


def test_a_real_user_message_forgives_the_quit_history():
    """ENG-364: empty_finish_total drives the 40% repeat floor and the vanishing-quit rule; it must
    reset with the rest of the per-ask budget or one false positive arms both forever."""
    import inspect
    from backend.apps.agents.manager import Messaging
    src = inspect.getsource(Messaging)
    block = src.split("session.empty_finish_nudges = 0", 1)[1].split("if not hidden and prompt", 1)[0]
    assert "session.empty_finish_total = 0" in block


def test_a_silent_quit_only_rebuilds_when_the_rebuild_would_reclaim_something():
    """ENG-354's exp.16 fix force-compacted AND set needs_fresh_session on EVERY repeat quit above
    40% of the trigger. Every rebuild re-sends an authored recap, and on the subscription lane that
    is a refusable request: fleet policy blocks went 1 install -> 7 the day it shipped, and Alex's
    quits land at 68-166K, above the 72K floor nearly every time, so he paid a rebuild per quit.

    The guard is reclaim measured against the REPORTED input, because a rebuild's win is discarding
    the CLI's own untrimmed transcript, not shrinking our local history. Both directions pinned: a
    bloated session still rebuilds (ENG-354 intact), a session already sitting at its post-rebuild
    size does not.

    Written the second time: the first version asserted the throttle on a session whose nudge ladder
    had simply exhausted, so it passed with reclaim still at 145,413 and proved nothing."""
    from backend.apps.agents.manager.run.empty_finish import maybe_nudge_empty_finish
    from backend.apps.agents.manager.session.proactive_prune import estimate_aged_rebuild_tokens

    def p_big_session() -> AgentSession:
        s = AgentSession(name="t", model="opus-5")
        s.context_window = 1_000_000
        s.messages.append(Message(role="user", content="do the work", branch_id="main"))
        for i in range(60):
            s.messages.append(Message(role="tool_call", content={"tool": "Bash", "input": {"command": f"run {i}"}}, branch_id="main"))
            s.messages.append(Message(role="tool_result", content={"tool_name": "Bash", "text": "x" * 6000}, branch_id="main"))
        return s

    # ENG-354 INTACT: the CLI is carrying a bloated transcript, so the rebuild is worth paying for.
    bloated = p_big_session()
    bloated.tokens["input"] = 150_000
    assert maybe_nudge_empty_finish(bloated, "sid-bloated") is True
    assert bloated.needs_fresh_session is True, "a quit on a bloated session must still compact and rebuild"

    # THE THROTTLE: the same session one rebuild later. The next turn reports the post-rebuild size,
    # so there is nothing left to discard and a second recap must not be sent. Fresh session object
    # so the nudge ladder cannot short-circuit this and make the arm vacuous.
    settled = p_big_session()
    settled.tokens["input"] = estimate_aged_rebuild_tokens(settled) + 5_000
    assert maybe_nudge_empty_finish(settled, "sid-settled") is True, "it must still nudge"
    assert settled.needs_fresh_session is False, "nothing left to reclaim: no rebuild, no second recap"


def test_a_small_session_never_pays_a_rebuild():
    """Negative control: a short chat has nothing to reclaim, so a silent quit there must never
    force a rebuild (and never send a recap) no matter what the token counter says."""
    import asyncio
    from unittest.mock import AsyncMock, patch
    import backend.apps.agents.manager.run.empty_finish as ef
    from backend.apps.agents.core import ws_manager as p_wsm

    s = AgentSession(name="t", model="opus-5")
    s.context_window = 1_000_000
    s.messages.append(Message(role="user", content="hi", branch_id="main"))
    s.messages.append(Message(role="tool_call", content={"tool": "Bash", "input": {}}, branch_id="main"))
    s.messages.append(Message(role="tool_result", content={"tool_name": "Bash", "text": "ok"}, branch_id="main"))
    s.tokens["input"] = 900_000  # a lying/stale counter must not be enough on its own
    async def p_run():
        return ef.maybe_nudge_empty_finish(s, "sid-small")

    with patch.object(p_wsm.ws_manager, "send_to_session", new=AsyncMock()):
        asyncio.run(p_run())
    assert s.needs_fresh_session is False, "nothing to reclaim means no rebuild and no recap"
