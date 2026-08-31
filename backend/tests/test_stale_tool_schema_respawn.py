"""ENG-394: the deferred-tool 400 is cured by a respawn, so it must not card out on top of the work.

Reproduced live on packaged 1.7.10-exp.2, 2026-08-31, deterministically: kill 9router, launch a
session, and the CLI defers all 44 MCP tools. The first ToolSearch that loads one sends it carrying
both defer_loading and cache_control, the API 400s, and the turn died after 61 real tool calls.

Control pair from that run: router UP -> 0 ToolSearch, both arms completed; router DOWN -> 1
ToolSearch, both arms 400.
"""
import pytest

from backend.apps.agents.core.error_classify import is_stale_tool_schema_error, is_transient_capacity_error
from backend.apps.agents.core.models import AgentSession
from backend.apps.agents.manager.streaming.auth_retry import (
    try_auth_self_heal,
    try_stale_tool_schema_self_heal,
)

REAL = (
    "The agent runtime reported this turn failed (stop_sequence). API Error: 400 "
    '{"error":{"message":"[claude/claude-sonnet-4-6] [400]: Tool '
    "'mcp__openswarm-core__CreateBrowserAgent' cannot have both defer_loading=true and cache_control "
    'set. Tools with defer_loading cannot use prompt caching. (reset after 30s)"}}'
)
REAL_SHOWUI = REAL.replace("CreateBrowserAgent", "ShowUI")
# The router truncates the upstream message mid-word; this is the byte-real card text from the
# packaged exp.3 drill (2026-08-31), and the first classifier missed it by anchoring on the full
# word "cache_control".
REAL_TRUNCATED = (
    "The agent runtime reported this turn failed (stop_sequence). API Error: 400 "
    '{"error":{"message":"[claude/claude-sonnet-4-6] [400]: Tool '
    "'mcp__openswarm-core__CreateBrowserAgent' cannot have both defer_loading=true and cache_ "
    '(reset after 15s)"}}'
)


def p_session() -> AgentSession:
    return AgentSession(id="s1", name="t", model="sonnet")


def test_the_real_400_from_the_live_drill_is_recognised():
    assert is_stale_tool_schema_error(RuntimeError(REAL))
    assert is_stale_tool_schema_error(RuntimeError(REAL_SHOWUI))


def test_the_router_truncated_form_is_recognised():
    assert is_stale_tool_schema_error(RuntimeError(REAL_TRUNCATED))


def test_the_respawn_waits_out_the_router_warm_up():
    """A 0s retry reconnects into the same dead window the first CLI hit (live: second 400 in <1s)."""
    s = p_session()
    assert try_stale_tool_schema_self_heal(s) is True
    assert s.pending_continuation_delay_s >= 15


def test_it_is_also_found_when_the_text_arrives_on_stderr():
    assert is_stale_tool_schema_error(RuntimeError("Command failed with exit code 1"), extra_text=REAL)


@pytest.mark.parametrize("innocent", [
    # The question this list answers: what legitimate case looks like the bad case?
    "API Error: 400 {\"error\":{\"message\":\"max_tokens is too large\"}}",
    "API Error: 429 rate_limit_error (reset after 21s)",
    "prompt caching is enabled for this request",
    "defer_loading is supported on this model",
    "File \"x.py\", line 400, in run  # cache_control mentioned in a traceback",
    "The model provider returned an expired-credential error",
])
def test_ordinary_failures_never_claim_a_respawn(innocent):
    assert not is_stale_tool_schema_error(RuntimeError(innocent))


def test_the_400_still_refuses_to_be_waited_on():
    """The ENG-395 rule must survive: this is a 400, so no backoff ladder may adopt it."""
    assert not is_transient_capacity_error(RuntimeError(REAL))


def test_one_respawn_is_armed_then_the_budget_is_spent():
    s = p_session()
    assert try_stale_tool_schema_self_heal(s) is True
    assert s.needs_respawn is True
    assert s.pending_continuation is True

    s.pending_continuation = False  # the dispatcher consumed it
    assert try_stale_tool_schema_self_heal(s) is False, "a second identical 400 must card, not loop"


def test_it_does_not_eat_the_auth_one_shot():
    """Separate budgets: these arrive by different doors moments apart."""
    s = p_session()
    assert try_stale_tool_schema_self_heal(s) is True
    s.pending_continuation = False
    assert try_auth_self_heal(s) is True, "the auth retry lost its budget to the schema retry"


def test_it_never_stomps_a_continuation_that_is_already_armed():
    s = p_session()
    s.pending_continuation = True
    s.pending_continuation_prompt = "something else already owns this"
    assert try_stale_tool_schema_self_heal(s) is False
    assert s.pending_continuation_prompt == "something else already owns this"


def test_the_veto_sits_above_every_card_emitting_branch():
    """Ordering, not just behaviour (the recurring defect in this codebase is a guard placed inside
    one branch). Below the generic handler this would card on top of the turn's work."""
    import inspect
    from backend.apps.agents.manager.run import handle_run_error as mod
    src = inspect.getsource(mod.handle_run_error)
    mine = src.index("is_stale_tool_schema_error(e")
    for later in ("is_context_overflow_error(e", "is_transient_capacity_error(e", "is_auth_error(e"):
        assert mine < src.index(later), f"the respawn veto must precede {later}"


@pytest.mark.asyncio
async def test_handle_run_error_arms_the_respawn_and_emits_no_card(monkeypatch):
    """The wiring test. The unit tests above all pass with the branch deleted from the handler,
    which is exactly how a fix ships broken; this one drives the real door."""
    from backend.apps.agents.manager.run import handle_run_error as mod
    from backend.apps.agents.manager.streaming.state import TurnState

    sent: list[tuple[str, dict]] = []

    async def p_send(session_id, event, payload):
        sent.append((event, payload))

    monkeypatch.setattr(mod.ws_manager, "send_to_session", p_send)

    s = p_session()
    s.dashboard_id = "d"
    turn = TurnState()
    await mod.handle_run_error(RuntimeError(REAL), s, s.id, turn, [])

    assert s.needs_respawn is True, "the CLI must be respawned; a fresh one re-registers its tools"
    assert s.pending_continuation is True, "the turn must continue, not die on top of its work"
    cards = [m for m in s.messages if m.role == "system"]
    assert cards == [], f"a curable 400 must not card out; got {[c.content[:60] for c in cards]}"
    assert not any(e == "agent:message" for e, _ in sent), "no error message may reach the user"


@pytest.mark.asyncio
async def test_the_second_identical_400_does_card(monkeypatch):
    """The reverse obligation: when respawning is provably not the cure, the user is owed the card
    rather than a silent loop."""
    from backend.apps.agents.manager.run import handle_run_error as mod
    from backend.apps.agents.manager.streaming.state import TurnState

    async def p_send(session_id, event, payload):
        return None

    monkeypatch.setattr(mod.ws_manager, "send_to_session", p_send)

    s = p_session()
    s.dashboard_id = "d"
    s.stale_tool_schema_retry_used = True  # the one-shot is already spent
    await mod.handle_run_error(RuntimeError(REAL), s, s.id, TurnState(), [])

    cards = [m for m in s.messages if m.role == "system"]
    assert cards, "a spent budget must produce an honest card"
    # The card must blame the actual culprit (our router restarting), never the model, and must
    # promise the thing that is proven to work (a plain resend on the same chat).
    text = cards[-1].content
    assert "router" in text.lower(), text
    assert "send your message again" in text.lower(), text
    assert "switch" not in text.lower(), "the generic switch-models advice blames the wrong thing"
