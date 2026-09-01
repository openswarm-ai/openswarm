"""Autocompact thrash that outlives the pressure valve must not be blamed on the model.

Field, 2026-09-01 (Ken, 1.7.9, sonnet-5, a LinkedIn outreach chat): the turn died with the CLI's own
verdict, "Autocompact is thrashing: the context refilled to the limit within 3 turns of the previous
compact, 3 times in a row." It was recorded as `unclassified` and the user was told:

    "The model provider returned an error instead of an answer. Send your message again; if it
     keeps happening, switch this agent to another model."

Wrong twice. It blames the provider for our own context problem, and switching models cannot help,
because a new model inherits the same oversized conversation and thrashes identically. The same chat
was visibly losing earlier steps, which is the same cause wearing a different face.

The valve (agent_manager) gets ONE fresh-session rebuild. A conversation that refills the window
within three turns does it again, and that second death is what reaches this handler.
"""
import pytest

from backend.apps.agents.core.models import AgentSession
from backend.apps.agents.core.error_classify import is_context_pressure_death

KEN = ("The agent runtime reported this turn failed (stop_sequence). Autocompact is thrashing: "
       "the context refilled to the limit within 3 turns of the previous compact, 3 times in a row.")


def test_the_field_error_is_recognised_at_zero_boundaries():
    """The CLI naming its own thrash is self-identifying; it must not need a boundary count."""
    assert is_context_pressure_death(RuntimeError(KEN), 0)


@pytest.mark.asyncio
async def test_the_card_names_the_conversation_not_the_model(monkeypatch):
    from backend.apps.agents.manager.run import handle_run_error as mod
    from backend.apps.agents.manager.streaming.state import TurnState

    sent = []

    async def p_send(session_id, event, payload):
        sent.append(event)

    monkeypatch.setattr(mod.ws_manager, "send_to_session", p_send)
    s = AgentSession(name="t", model="sonnet-5", dashboard_id="d")
    await mod.handle_run_error(RuntimeError(KEN), s, s.id, TurnState(), [])

    cards = [m for m in s.messages if m.role == "system"]
    assert len(cards) == 1
    text = cards[0].content.lower()
    assert "switching models will not help" in text, "the wrong remedy must be ruled OUT explicitly"
    assert "fresh chat" in text, "and the one that works must be named"
    assert "forgetting" in text, "the memory loss the user is also seeing has the same cause; say so"
    assert "provider returned an error" not in text, "the generic model-blaming card must not fire"


@pytest.mark.asyncio
async def test_it_sits_above_the_generic_fallback(monkeypatch):
    """Ordering, not just presence: the generic `else` is what produced the bad advice, so a branch
    added below it would change nothing."""
    import inspect
    import re
    from backend.apps.agents.manager.run import handle_run_error as mod
    src = inspect.getsource(mod.handle_run_error)
    # Line-anchored: a bare `src.index("    else:")` also matches the deeper `        else:` of a
    # nested block and reported a false failure while the real ordering was fine.
    p_fallback = re.search(r"^    else:", src, re.M)
    assert p_fallback, "the unclassified fallback should still exist"
    assert src.index("is_context_pressure_death(e") < p_fallback.start(), \
        "the thrash branch must precede the unclassified fallback"


@pytest.mark.asyncio
@pytest.mark.parametrize("innocent", [
    "API Error: 429 rate_limit_error (reset after 21s)",
    "API Error: 401 authentication_error",
    "This conversation has grown too large for your account's standard context window",
])
async def test_errors_that_belong_to_other_branches_are_not_stolen(innocent):
    """is_context_pressure_death only claims deaths no other classifier owns."""
    assert not is_context_pressure_death(RuntimeError(innocent), 1)
