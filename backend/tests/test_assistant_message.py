"""Direct coverage for the extracted AssistantMessage handler. The harness drives the common
paths; these pin the branches it doesn't: the router-auth-expiry friendly card, tool-call
commit, and per-turn output-token accumulation."""

import pytest
from unittest.mock import patch, AsyncMock

from claude_agent_sdk import AssistantMessage
from claude_agent_sdk.types import TextBlock, ToolUseBlock

from backend.apps.agents.core.models import AgentSession
from backend.apps.agents.manager.streaming.state import TurnState, ThinkingState
from backend.apps.agents.manager.streaming import handle_assistant_message as assistant_message


def p_asst(blocks, usage=None):
    return AssistantMessage(content=blocks, model="sonnet", message_id="m1", stop_reason="end_turn",
                            session_id="s", usage=usage or {"input_tokens": 1, "output_tokens": 1})


def p_fixt():
    return AgentSession(name="t", model="sonnet", dashboard_id="d"), TurnState(), ThinkingState()


@pytest.mark.asyncio
async def test_plain_text_commits_assistant_message():
    session, turn, thinking = p_fixt()
    with patch.object(assistant_message.ws_manager, "send_to_session", new=AsyncMock()):
        await assistant_message.handle_assistant_message(
            p_asst([TextBlock(text="Hello there")]), session, session.id, turn, thinking, {}, {})
    assert any(m.role == "assistant" and "Hello there" in str(m.content) for m in session.messages)
    assert turn.number == 1


@pytest.mark.asyncio
async def test_first_token_expiry_heals_silently(monkeypatch):
    # ENG-294: the first expiry in an ask must cost the user ZERO actions: no banner, no committed
    # reply, just a fresh-CLI rebuild and one hidden retry queued on the continuation seam.
    session, turn, thinking = p_fixt()
    txt = "[codex/gpt-5] Failed to authenticate: 401 provided authentication token is expired"
    events = []

    async def fake_send(sid, event, data):
        events.append(event)

    with patch.object(assistant_message.ws_manager, "send_to_session", new=fake_send):
        await assistant_message.handle_assistant_message(
            p_asst([TextBlock(text=txt)]), session, session.id, turn, thinking, {}, {})
    # ENG-361 amended this contract: the codex retry now waits ~75s to clear the rotation window,
    # and a minute of nothing reads as a hang, so ONE slim "retrying automatically" notice is
    # expected. What must never appear is the reconnect BANNER, because there is nothing for the
    # user to do. The distinction is the whole point: a notice informs, a banner assigns homework.
    p_sys = [m for m in session.messages if m.role == "system"]
    assert len(p_sys) == 1, "exactly one slim notice, not a wall"
    assert "no action needed" in p_sys[0].content.lower()
    assert "reconnect" not in p_sys[0].content.lower(), "never demand a reconnect on the first expiry"
    assert not any(m.role == "assistant" for m in session.messages)
    assert "agent:auth_error" not in events
    assert session.auth_retry_used is True
    assert session.needs_fresh_session is True, "the fresh CLI is what drops the stale token"
    assert session.pending_continuation is True and session.pending_continuation_prompt
    assert turn.number == 1, "healing must not skip the turn bookkeeping"


@pytest.mark.asyncio
async def test_second_token_expiry_surfaces_card_not_assistant_text():
    # The banner is the SECOND rung: a credential that fails right after a rebuilt session is
    # genuinely dead, and swallowing every 401 forever is the failure mode this refuses.
    session, turn, thinking = p_fixt()
    session.auth_retry_used = True
    session.pending_continuation = False
    txt = "[codex/gpt-5] Failed to authenticate: 401 provided authentication token is expired"
    events = []

    async def fake_send(sid, event, data):
        events.append(event)

    with patch.object(assistant_message.ws_manager, "send_to_session", new=fake_send):
        await assistant_message.handle_assistant_message(
            p_asst([TextBlock(text=txt)]), session, session.id, turn, thinking, {}, {})
    assert any(m.role == "system" for m in session.messages)        # friendly card
    assert not any(m.role == "assistant" for m in session.messages)  # NOT committed as the reply
    assert "agent:auth_error" in events


def test_heal_never_stacks_on_a_pending_continuation():
    from backend.apps.agents.manager.streaming.auth_retry import try_auth_self_heal
    session = AgentSession(name="t", model="sonnet", dashboard_id="d")
    session.pending_continuation = True
    assert try_auth_self_heal(session) is False, "stacking would double-fire the continuation seam"
    assert session.auth_retry_used is False, "a refused heal must not burn the budget"


def test_a_real_user_message_reopens_the_heal_budget():
    # Wire-check both directions: the flag is set by the heal AND cleared with the other per-ask
    # budgets on a real (non-hidden) user message.
    import inspect
    from backend.apps.agents.manager import Messaging
    src = inspect.getsource(Messaging)
    block = src[src.index("if not hidden:"):src.index("if not hidden:") + 400]
    assert "auth_retry_used = False" in block


@pytest.mark.asyncio
async def test_tool_use_block_commits_tool_call():
    session, turn, thinking = p_fixt()
    with patch.object(assistant_message.ws_manager, "send_to_session", new=AsyncMock()):
        await assistant_message.handle_assistant_message(
            p_asst([ToolUseBlock(id="tu1", name="Read", input={"file_path": "/x"})]),
            session, session.id, turn, thinking, {}, {})
    assert any(m.role == "tool_call" for m in session.messages)


@pytest.mark.asyncio
async def test_output_tokens_accumulate_onto_turn():
    session, turn, thinking = p_fixt()
    with patch.object(assistant_message.ws_manager, "send_to_session", new=AsyncMock()):
        await assistant_message.handle_assistant_message(
            p_asst([TextBlock(text="hi")], usage={"input_tokens": 10, "output_tokens": 42}),
            session, session.id, turn, thinking, {}, {})
    assert turn.output_tokens == 42


# --- provider errors must never wear the agent's face (ENG stop-cause #10) ------------------------
#
# The strings below are verbatim from backend/data/sessions on 2026-08-20, where 14 of 2049
# assistant messages were raw provider errors rendered as the agent speaking. Inventing the shape
# would have tested my memory of a 429 rather than the one Gemini actually sends.

REAL_GEMINI_SHORT_QUOTA = (
    "API Error: Request rejected (429) · [antigravity/gemini-3-flash] [429]: Individual quota "
    "reached. Please upgrade your subscription to increase your limits. Resets in "
    "(reset after 1m 56s)"
)
REAL_GEMINI_LONG_QUOTA = (
    "API Error: Request rejected (429) · [antigravity/gemini-3-flash] [429]: Individual quota "
    "reached. Please upgrade your subscription to increase your limits. Resets in 125h40m51s. "
    "(reset after 2m)"
)
REAL_CLAUDE_CONNECTION = "API Error: Unable to connect. Is the computer able to access the url?"


@pytest.mark.asyncio
async def test_a_rate_limit_never_reaches_the_user_as_the_agents_own_words():
    session, turn, thinking = p_fixt()
    with patch.object(assistant_message.ws_manager, "send_to_session", new=AsyncMock()):
        await assistant_message.handle_assistant_message(
            p_asst([TextBlock(text=REAL_GEMINI_SHORT_QUOTA)]), session, session.id, turn,
            thinking, {}, {})
    assert not any(m.role == "assistant" for m in session.messages), \
        "the provider spoke, not the agent; committing it as assistant text is the bug"
    p_sys = [m for m in session.messages if m.role == "system"]
    assert len(p_sys) == 1
    body = p_sys[0].content
    assert "429" not in body and "API Error" not in body, "no provider jargon reaches the user"
    assert "upgrade your subscription" not in body.lower(), "no vendor upsell in our voice"


@pytest.mark.asyncio
async def test_a_short_rate_limit_resumes_itself_rather_than_asking_the_user():
    session, turn, thinking = p_fixt()
    with patch.object(assistant_message.ws_manager, "send_to_session", new=AsyncMock()):
        await assistant_message.handle_assistant_message(
            p_asst([TextBlock(text=REAL_GEMINI_SHORT_QUOTA)]), session, session.id, turn,
            thinking, {}, {})
    assert session.pending_continuation is True, "a 2-minute wait is ours to do, not the user's"
    assert session.pending_continuation_delay_s == 116, "wait the window the provider named"
    assert session.auth_retry_used is False, "a rate limit must not spend the expired-token retry"


@pytest.mark.asyncio
async def test_a_five_day_quota_tells_the_user_instead_of_parking_forever():
    session, turn, thinking = p_fixt()
    with patch.object(assistant_message.ws_manager, "send_to_session", new=AsyncMock()):
        await assistant_message.handle_assistant_message(
            p_asst([TextBlock(text=REAL_GEMINI_LONG_QUOTA)]), session, session.id, turn,
            thinking, {}, {})
    assert session.pending_continuation is False, \
        "parking on a multi-day reset is a silent stop wearing a retry's clothes"
    body = [m for m in session.messages if m.role == "system"][0].content
    assert "switch" in body.lower(), "give the one action that actually works"


@pytest.mark.asyncio
async def test_a_dropped_connection_parks_and_promises_resume():
    session, turn, thinking = p_fixt()
    with patch.object(assistant_message.ws_manager, "send_to_session", new=AsyncMock()):
        await assistant_message.handle_assistant_message(
            p_asst([TextBlock(text=REAL_CLAUDE_CONNECTION)]), session, session.id, turn,
            thinking, {}, {})
    assert session.pending_continuation is True
    body = [m for m in session.messages if m.role == "system"][0].content
    assert "resend" in body.lower() or "do not need" in body.lower()


@pytest.mark.asyncio
async def test_the_transient_budget_is_two_then_it_says_so():
    """Section 5: the fix must not trade a visible stop for an endless invisible one."""
    session, turn, thinking = p_fixt()
    for _ in range(3):
        session.pending_continuation = False  # dispatcher consumes it between turns
        with patch.object(assistant_message.ws_manager, "send_to_session", new=AsyncMock()):
            await assistant_message.handle_assistant_message(
                p_asst([TextBlock(text=REAL_GEMINI_SHORT_QUOTA)]), session, session.id, turn,
                thinking, {}, {})
    assert session.transient_retry_count == 2, "budget is two, not unbounded"
    assert session.pending_continuation is False, "the third failure stops retrying"
    assert "send your message again" in session.messages[-1].content.lower()


@pytest.mark.asyncio
async def test_the_agent_can_still_talk_about_an_error_it_saw():
    """NEGATIVE CONTROL. Without this, the fix quietly deletes a real capability (VERIFICATION 5b).

    A user asking "why did my deploy fail" gets an answer that necessarily contains status codes.
    If that answer is swallowed as a provider error, this fix is a worse bug than the one it cures.
    """
    session, turn, thinking = p_fixt()
    prose = ("I read the logs: the server returned a 429 rate limit on three requests and a 401 on "
             "one. I added a backoff, and the API Error you saw should stop.")
    with patch.object(assistant_message.ws_manager, "send_to_session", new=AsyncMock()):
        await assistant_message.handle_assistant_message(
            p_asst([TextBlock(text=prose)]), session, session.id, turn, thinking, {}, {})
    assert any(m.role == "assistant" and "429" in str(m.content) for m in session.messages), \
        "the agent's own analysis must reach the user intact"
    assert not any(m.role == "system" for m in session.messages)
    assert session.pending_continuation is False
