"""Per-action browser-command timeouts.

A hung tab makes every command block to its timeout; a flat 30s let one wedged
page spin ~20 minutes across retries. These pin that the bound is now short and
per-action, so a freeze surfaces in seconds.
"""

import asyncio
import time

import pytest

from backend.apps.agents.core import ws_manager as wsm
from backend.apps.agents.core.ws_manager import BrowserCommandOwner

P_LOCAL = BrowserCommandOwner(origin="renderer")


class p_FakeSock:
    async def send_text(self, _):
        return None


def p_mgr():
    m = wsm.ConnectionManager()
    m.global_connections = [p_FakeSock()]  # get past the 'no dashboard' guard
    return m


def test_timeout_map_reads_are_short_navigation_longer():
    # reads/clicks act on a loaded page -> short; navigation loads network -> longer
    assert wsm.BROWSER_CMD_TIMEOUT_DEFAULT <= 15
    assert wsm.BROWSER_CMD_TIMEOUTS["navigate"] <= 25
    assert wsm.BROWSER_CMD_TIMEOUTS["navigate"] > wsm.BROWSER_CMD_TIMEOUT_DEFAULT
    # the old flat 30s is gone for the common path
    assert wsm.BROWSER_CMD_TIMEOUT_DEFAULT < 30


@pytest.mark.asyncio
async def test_hung_command_returns_fast_at_the_bound(monkeypatch):
    # shrink the bounds so the test is quick, then never resolve the future: the command must return a timeout error at ~the (default) bound, not hang.
    monkeypatch.setattr(wsm, "BROWSER_CMD_TIMEOUT_DEFAULT", 0.3)
    monkeypatch.setattr(wsm, "BROWSER_CMD_TIMEOUTS", {"navigate": 0.6})
    m = p_mgr()
    t0 = time.monotonic()
    res = await m.send_browser_command("rid1", "get_text", "b1", {}, owner=P_LOCAL)  # never resolved
    elapsed = time.monotonic() - t0
    assert res == {"error": "Browser command timed out"}
    assert 0.25 < elapsed < 1.0, f"a read should time out near its 0.3s bound, took {elapsed:.2f}s"


@pytest.mark.asyncio
async def test_navigate_gets_the_longer_leash(monkeypatch):
    monkeypatch.setattr(wsm, "BROWSER_CMD_TIMEOUT_DEFAULT", 0.3)
    monkeypatch.setattr(wsm, "BROWSER_CMD_TIMEOUTS", {"navigate": 0.7})
    m = p_mgr()
    t0 = time.monotonic()
    await m.send_browser_command("rid2", "navigate", "b1", {"url": "x"}, owner=P_LOCAL)
    elapsed = time.monotonic() - t0
    assert elapsed > 0.5, "navigate should use its longer bound, not the default"


@pytest.mark.asyncio
async def test_lost_first_delivery_heals_via_rebroadcast(monkeypatch):
    # a silently-dead socket eats the first broadcast; the re-send after the rebroadcast interval must reach the (reconnected) client and succeed
    monkeypatch.setattr(wsm, "BROWSER_CMD_TIMEOUT_DEFAULT", 5.0)
    monkeypatch.setattr(wsm, "BROWSER_CMD_REBROADCAST_S", 0.1)
    m = p_mgr()
    sends = []

    class p_CountingSock:
        async def send_text(self, payload):
            sends.append(payload)
            if len(sends) >= 2:  # first delivery "lost", second lands
                rid = next(iter(m.browser_futures))
                m.resolve_browser_command(rid, {"text": "ok"}, claimant=P_LOCAL)

    m.global_connections = [p_CountingSock()]
    res = await m.send_browser_command("rid4", "get_text", "b1", {}, owner=P_LOCAL)
    assert res == {"text": "ok"}
    assert len(sends) >= 2, "command must be re-broadcast until a client answers"


# --- the window closing MID-command ------------------------------------------------------------
# The entry check only guards the START of a command. Measured live: a run in flight when the
# window closed took 240.9s, while one that started after it was already gone failed honestly in
# 11.6s. Same code, outcome decided purely by timing.

@pytest.mark.asyncio
async def test_a_window_closing_mid_command_fails_fast_not_at_the_bound(monkeypatch):
    monkeypatch.setattr(wsm, "BROWSER_CMD_TIMEOUT_DEFAULT", 30.0)  # a long leash, as navigate has
    monkeypatch.setattr(wsm, "BROWSER_CMD_REBROADCAST_S", 0.1)
    monkeypatch.setattr(wsm, "P_WS_RECONNECT_WAIT_S", 0.3)
    m = p_mgr()

    async def p_close_window_soon():
        await asyncio.sleep(0.05)
        m.global_connections = []  # red-button close: socket gone, future never resolves

    asyncio.create_task(p_close_window_soon())
    t0 = time.monotonic()
    res = await m.send_browser_command("rid5", "get_text", "b1", {}, owner=P_LOCAL)
    elapsed = time.monotonic() - t0
    # the agent's card-gone streak keys on this exact wording, so it must match the entry check's
    assert res == {"error": "No dashboard is connected. Open the dashboard to use browser tools."}
    assert elapsed < 3.0, f"a closed window must not cost the full 30s leash, took {elapsed:.2f}s"


@pytest.mark.asyncio
async def test_the_fast_fail_wording_is_the_one_the_agent_watches_for():
    # If these ever drift apart, a dead browser silently stops tripping the abort and starts spinning.
    from backend.apps.agents.browser.browser_loop import card_is_unavailable
    m = wsm.ConnectionManager()
    m.global_connections = []
    res = await m.send_browser_command("rid6", "get_text", "b1", {}, owner=P_LOCAL)
    assert card_is_unavailable(res), "the not-connected error must read as a gone card"


@pytest.mark.asyncio
async def test_a_brief_socket_blip_still_rides_through(monkeypatch):
    # A CPU-starved renderer drops its WS for a beat and reconnects. That must NOT kill a live run.
    monkeypatch.setattr(wsm, "BROWSER_CMD_TIMEOUT_DEFAULT", 5.0)
    monkeypatch.setattr(wsm, "BROWSER_CMD_REBROADCAST_S", 0.1)
    monkeypatch.setattr(wsm, "P_WS_RECONNECT_WAIT_S", 2.0)
    m = p_mgr()
    sock = m.global_connections[0]

    async def p_blip_then_return():
        await asyncio.sleep(0.05)
        m.global_connections = []          # blip
        await asyncio.sleep(0.2)
        m.global_connections = [sock]      # frontend reconnects
        await asyncio.sleep(0.15)
        rid = next(iter(m.browser_futures))
        m.resolve_browser_command(rid, {"text": "ok"}, claimant=P_LOCAL)

    asyncio.create_task(p_blip_then_return())
    res = await m.send_browser_command("rid7", "get_text", "b1", {}, owner=P_LOCAL)
    assert res == {"text": "ok"}, "a reconnect inside the grace must not fail the command"


@pytest.mark.asyncio
async def test_a_resolved_command_returns_immediately(monkeypatch):
    # a healthy command returns the moment the renderer resolves it, not at the bound
    monkeypatch.setattr(wsm, "BROWSER_CMD_TIMEOUT_DEFAULT", 5.0)
    m = p_mgr()

    async def p_resolve_soon():
        await asyncio.sleep(0.05)
        # find the pending future and resolve it like the renderer would
        rid = next(iter(m.browser_futures))
        m.resolve_browser_command(rid, {"text": "ok", "url": "u"}, claimant=P_LOCAL)

    asyncio.create_task(p_resolve_soon())
    t0 = time.monotonic()
    res = await m.send_browser_command("rid3", "get_text", "b1", {}, owner=P_LOCAL)
    elapsed = time.monotonic() - t0
    assert res == {"text": "ok", "url": "u"}
    assert elapsed < 1.0, "healthy command returns on resolve, not at the timeout"
