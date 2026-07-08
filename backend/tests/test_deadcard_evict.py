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
    broadcasts, saved, dash = p_patch(monkeypatch, {"browser-dead": FakeCard("sess-1"), "browser-keep": FakeCard("sess-1")})
    ba.ACTIVE_AGENT_CARDS.add("browser-dead")
    asyncio.run(ba.p_evict_dead_card("dash-1", "browser-dead"))
    # the renderer is told to unmount exactly the dead card
    assert ("dashboard:browser_card_evict", {"dashboard_id": "dash-1", "browser_id": "browser-dead"}) in broadcasts
    # it's gone from the persisted layout, its neighbor is untouched
    assert "browser-dead" not in dash.layout.browser_cards
    assert "browser-keep" in dash.layout.browser_cards
    assert saved  # the layout was persisted
    assert "browser-dead" not in ba.ACTIVE_AGENT_CARDS


def test_evict_without_a_dashboard_deletes_nothing(monkeypatch):
    # No dashboard = ownership unverifiable = fail SAFE: never unmount or delete
    # what might be the user's card; the reuse-skip alone handles it.
    broadcasts, saved, _ = p_patch(monkeypatch, {})
    asyncio.run(ba.p_evict_dead_card("", "browser-x"))
    assert not broadcasts and not saved


class FakeCard:
    def __init__(self, spawned_by=None):
        self.spawned_by = spawned_by


def test_user_card_is_never_evicted(monkeypatch):
    """A wedged USER card (no spawned_by) must never be deleted out from under the
    user; reuse-skip is the whole remedy. Only agent-spawned cards evict."""
    broadcasts, saved, dash = p_patch(monkeypatch, {"browser-user": FakeCard(None)})
    asyncio.run(ba.p_evict_dead_card("dash-1", "browser-user"))
    assert not broadcasts and not saved
    assert "browser-user" in dash.layout.browser_cards
