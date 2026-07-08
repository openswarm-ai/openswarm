"""The recovery-card wedge fix: when a card is declared dead, its webview must be
torn down (renderer unmount + layout removal) BEFORE recovery spawns a fresh card,
so two heavy pages never co-exist and starve the renderer. Pins p_evict_dead_card."""
import asyncio

import backend.apps.agents.browser.browser_agent as ba


class FakeLayout:
    def __init__(self, cards):
        self.browser_cards = cards


class FakeDash:
    def __init__(self, cards):
        self.layout = FakeLayout(cards)
        self.updated_at = None


def p_patch(monkeypatch, cards):
    broadcasts = []
    saved = []

    async def fake_broadcast(event, data):
        broadcasts.append((event, data))

    dash = FakeDash(cards)
    monkeypatch.setattr(ba, "P_EVICT_SETTLE_S", 0, raising=True)  # don't pay the renderer-settle wait in a unit test
    monkeypatch.setattr(ba.ws_manager, "broadcast_global", fake_broadcast, raising=True)
    import backend.apps.dashboards.dashboards as dmod
    monkeypatch.setattr(dmod, "load", lambda did: dash, raising=True)
    monkeypatch.setattr(dmod, "save", lambda d: saved.append(d), raising=True)
    return broadcasts, saved, dash


def test_evict_broadcasts_unmount_and_removes_from_layout(monkeypatch):
    broadcasts, saved, dash = p_patch(monkeypatch, {"browser-dead": object(), "browser-keep": object()})
    ba.ACTIVE_AGENT_CARDS.add("browser-dead")
    asyncio.run(ba.p_evict_dead_card("dash-1", "browser-dead"))
    # the renderer is told to unmount exactly the dead card
    assert ("dashboard:browser_card_evict", {"dashboard_id": "dash-1", "browser_id": "browser-dead"}) in broadcasts
    # it's gone from the persisted layout, its neighbor is untouched
    assert "browser-dead" not in dash.layout.browser_cards
    assert "browser-keep" in dash.layout.browser_cards
    assert saved  # the layout was persisted
    assert "browser-dead" not in ba.ACTIVE_AGENT_CARDS


def test_evict_is_fail_open_without_a_dashboard(monkeypatch):
    broadcasts, saved, _ = p_patch(monkeypatch, {})
    # no dashboard id: still tells the renderer to unmount (best-effort), never raises
    asyncio.run(ba.p_evict_dead_card("", "browser-x"))
    assert broadcasts and broadcasts[0][0] == "dashboard:browser_card_evict"
    assert not saved  # nothing to persist without a dashboard
