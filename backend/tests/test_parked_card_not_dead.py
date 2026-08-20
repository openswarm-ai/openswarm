"""A browser card the renderer parked is slow, not dead.

Field report 2026-08-20: "when I have multiple agents each driving their own browser, the browsers
seem to say they've completed without actually performing any actions." Solo runs were fine. The
cause was a timing race nobody had connected: the renderer caps live webviews at 8 and parks the rest
as snapshots, waking one takes up to 12s (awaitWebview), and the backend's dead-card probe gave it
6s. Past the cap, every extra agent's card was declared dead, evicted, and its child then "declared
done without taking a single action". The renderer now stamps woke_from_park on the result and the
backend never counts such a result toward the gone streak.
"""

from backend.apps.agents.browser.browser_loop import (
    CARD_GONE_LIMIT,
    CARD_GONE_MARKERS,
    card_is_unavailable,
)
from backend.apps.agents.browser import browser_agent
from backend.apps.agents.core.ws_manager import BROWSER_CMD_TIMEOUTS, BROWSER_CMD_TIMEOUT_DEFAULT

# The renderer's suspended-card wake deadline (awaitWebview, frontend/src/shared/browserCommandHandler.ts).
RENDERER_WAKE_DEADLINE_S = 12.0


def test_a_woke_from_park_timeout_is_not_a_gone_card():
    slow_but_alive = {"error": "Browser command timed out", "woke_from_park": True}
    assert card_is_unavailable(slow_but_alive) is False


def test_a_woke_from_park_not_found_is_not_a_gone_card():
    """The wake can miss its window and the handler then reports 'not an Electron webview';
    that exact phrase is a gone marker, so the stamp must override it too."""
    r = {"error": "Browser card 'browser-x' not found or not an Electron webview", "woke_from_park": True}
    assert card_is_unavailable(r) is False


def test_a_genuinely_gone_card_is_still_gone():
    """NEGATIVE CONTROL. The stamp must not blind the gate to a card that really closed; a wedged tab
    spinning for 20 minutes is the failure this gate exists to stop."""
    for marker in CARD_GONE_MARKERS:
        assert card_is_unavailable({"error": f"xx {marker} xx"}) is True
        assert card_is_unavailable({"error": f"xx {marker} xx", "woke_from_park": False}) is True


def test_the_probe_budget_outlasts_the_renderer_wake():
    """The two numbers live in different languages in different directories; this pins them."""
    assert browser_agent.PARKED_WAKE_BUDGET_S > RENDERER_WAKE_DEADLINE_S


def test_no_command_timeout_sits_at_or_under_the_wake():
    """Any action whose timeout cannot outlast a park wake turns every parked card into a timeout,
    which is two strikes from eviction. 'wait' sat at exactly 12.0 with zero margin."""
    assert BROWSER_CMD_TIMEOUT_DEFAULT > RENDERER_WAKE_DEADLINE_S
    for action, t in BROWSER_CMD_TIMEOUTS.items():
        assert t > RENDERER_WAKE_DEADLINE_S, f"{action} timeout {t}s cannot outlast a {RENDERER_WAKE_DEADLINE_S}s wake"


def test_gone_limit_is_still_two():
    """If someone raises the limit to paper over this instead, the wedged-tab spin comes back."""
    assert CARD_GONE_LIMIT == 2
