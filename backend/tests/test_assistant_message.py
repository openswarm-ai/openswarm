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
    assert session.needs_respawn is True, "a new CLI process is what drops the stale token; the transcript stays"
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


@pytest.mark.parametrize("flag", ["auth_retry_used", "stale_tool_schema_retry_used"])
def test_a_real_user_message_reopens_the_heal_budget(flag):
    """Wire-check both directions: each one-shot is set by its heal AND cleared with the other
    per-ask budgets when a real (non-hidden) user message arrives.

    Anchored on the reset block's own comment rather than on the FIRST `if not hidden:` plus a
    400-character window: that version silently started reading a different block the moment an
    unrelated `if not hidden:` was added earlier in the file, and failed for a reason that had
    nothing to do with the behaviour it guards.
    """
    import inspect
    from backend.apps.agents.manager import Messaging
    src = inspect.getsource(Messaging)
    start = src.index("A human actively driving the session forgives its crash history")
    block = src[start:src.index("if not hidden:", start)] if "if not hidden:" in src[start:] else src[start:]
    assert f"{flag} = False" in block, (
        f"{flag} is never reopened, so one spent retry disarms that heal for the session's life"
    )


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
# A genuine "slow down", with no claim that the plan is spent. This one IS worth waiting out.
TRUE_RATE_LIMIT = (
    "API Error: Request rejected (429) · [antigravity/gemini-3-flash] [429]: slow down. "
    "(reset after 2m)"
)


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
            p_asst([TextBlock(text=TRUE_RATE_LIMIT)]), session, session.id, turn,
            thinking, {}, {})
    assert session.pending_continuation is True, "a 2-minute wait is ours to do, not the user's"
    assert session.pending_continuation_delay_s == 120, "wait the window the provider named"
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
                p_asst([TextBlock(text=TRUE_RATE_LIMIT)]), session, session.id, turn,
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


@pytest.mark.asyncio
async def test_a_spent_plan_is_never_retried_however_short_its_window():
    """Packaged drill 2026-08-20: the same 'quota reached' envelope carries a 5-day reset one turn
    and a 2-minute one the next, so a window-only reading told the user to switch models and then,
    seconds later, to sit tight. A spent plan is spent whatever number rides along."""
    session, turn, thinking = p_fixt()
    with patch.object(assistant_message.ws_manager, "send_to_session", new=AsyncMock()):
        await assistant_message.handle_assistant_message(
            p_asst([TextBlock(text=REAL_GEMINI_SHORT_QUOTA)]), session, session.id, turn,
            thinking, {}, {})
    assert session.pending_continuation is False, "waiting cannot refill a plan"
    assert session.provider_verdict_final is True
    body = [m for m in session.messages if m.role == "system"][0].content
    assert "automatically" not in body.lower(), "never promise a resume that cannot happen"
    assert "switch" in body.lower()


@pytest.mark.asyncio
async def test_a_final_verdict_stops_the_ladder_and_the_cards():
    """The wall: after a terminal verdict the ladder kept retrying and every retry added a card
    contradicting the one before it. Seven cards, three mutually exclusive instructions."""
    session, turn, thinking = p_fixt()
    for text in (REAL_GEMINI_SHORT_QUOTA, TRUE_RATE_LIMIT, REAL_GEMINI_SHORT_QUOTA):
        session.pending_continuation = False
        with patch.object(assistant_message.ws_manager, "send_to_session", new=AsyncMock()):
            await assistant_message.handle_assistant_message(
                p_asst([TextBlock(text=text)]), session, session.id, turn, thinking, {}, {})
    p_cards = [m for m in session.messages if m.role == "system"]
    assert len(p_cards) == 1, f"one verdict per ask, got {len(p_cards)}"
    assert session.transient_retry_count == 0, "no retries after a terminal verdict"


@pytest.mark.asyncio
async def test_the_same_kind_twice_rewrites_one_card_instead_of_stacking():
    session, turn, thinking = p_fixt()
    for _ in range(3):
        session.pending_continuation = False
        with patch.object(assistant_message.ws_manager, "send_to_session", new=AsyncMock()):
            await assistant_message.handle_assistant_message(
                p_asst([TextBlock(text=REAL_CLAUDE_CONNECTION)]), session, session.id, turn,
                thinking, {}, {})
    assert len([m for m in session.messages if m.role == "system"]) == 1


@pytest.mark.asyncio
async def test_a_different_kind_still_earns_its_own_card():
    """NEGATIVE CONTROL. Dedup by kind must not swallow a genuinely different failure, or the user
    stops being told when the problem changes underneath them."""
    session, turn, thinking = p_fixt()
    with patch.object(assistant_message.ws_manager, "send_to_session", new=AsyncMock()):
        await assistant_message.handle_assistant_message(
            p_asst([TextBlock(text=REAL_CLAUDE_CONNECTION)]), session, session.id, turn,
            thinking, {}, {})
        session.pending_continuation = False
        await assistant_message.handle_assistant_message(
            p_asst([TextBlock(text=REAL_GEMINI_SHORT_QUOTA)]), session, session.id, turn,
            thinking, {}, {})
    p_cards = [m for m in session.messages if m.role == "system"]
    assert len(p_cards) == 2, "connection and quota are different problems"


@pytest.mark.asyncio
async def test_policy_refusal_in_the_assistants_place_is_raised_to_the_run_error_owner():
    """The CLI hands a policy block over as assistant text; it must reach handle_run_error (recap
    ratchet + honest card + telemetry) instead of being carded as a retry that never happens."""
    from backend.apps.agents.manager.streaming.handle_result_message import TurnResultError
    session, turn, thinking = p_fixt()
    txt = ("API Error: 400 https://www.anthropic.com/legal/aup). This request was blocked as it seems "
           "to violate Anthropic's Terms of Service restrictions on reverse engineering or duplicating model outputs.")
    with patch.object(assistant_message.ws_manager, "send_to_session", new=AsyncMock()):
        with pytest.raises(TurnResultError):
            await assistant_message.handle_assistant_message(
                p_asst([TextBlock(text=txt)]), session, session.id, turn, thinking, {}, {})
    assert not any(m.role == "system" for m in session.messages), "no card from this door"
    assert not any(m.role == "assistant" for m in session.messages), "the refusal is never the agent's words"
