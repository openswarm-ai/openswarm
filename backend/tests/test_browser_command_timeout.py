"""Per-action browser-command timeouts.

A hung tab makes every command block to its timeout; a flat 30s let one wedged
page spin ~20 minutes across retries. These pin that the bound is now short and
per-action, so a freeze surfaces in seconds.
"""

import asyncio
import time

import pytest

from backend.apps.agents.core import ws_manager as wsm


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
    res = await m.send_browser_command("rid1", "get_text", "b1", {})  # never resolved
    elapsed = time.monotonic() - t0
    assert res == {"error": "Browser command timed out"}
    assert 0.25 < elapsed < 1.0, f"a read should time out near its 0.3s bound, took {elapsed:.2f}s"


@pytest.mark.asyncio
async def test_navigate_gets_the_longer_leash(monkeypatch):
    monkeypatch.setattr(wsm, "BROWSER_CMD_TIMEOUT_DEFAULT", 0.3)
    monkeypatch.setattr(wsm, "BROWSER_CMD_TIMEOUTS", {"navigate": 0.7})
    m = p_mgr()
    t0 = time.monotonic()
    await m.send_browser_command("rid2", "navigate", "b1", {"url": "x"})
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
                m.resolve_browser_command(rid, {"text": "ok"})

    m.global_connections = [p_CountingSock()]
    res = await m.send_browser_command("rid4", "get_text", "b1", {})
    assert res == {"text": "ok"}
    assert len(sends) >= 2, "command must be re-broadcast until a client answers"


@pytest.mark.asyncio
async def test_a_resolved_command_returns_immediately(monkeypatch):
    # a healthy command returns the moment the renderer resolves it, not at the bound
    monkeypatch.setattr(wsm, "BROWSER_CMD_TIMEOUT_DEFAULT", 5.0)
    m = p_mgr()

    async def p_resolve_soon():
        await asyncio.sleep(0.05)
        # find the pending future and resolve it like the renderer would
        rid = next(iter(m.browser_futures))
        m.resolve_browser_command(rid, {"text": "ok", "url": "u"})

    asyncio.create_task(p_resolve_soon())
    t0 = time.monotonic()
    res = await m.send_browser_command("rid3", "get_text", "b1", {})
    elapsed = time.monotonic() - t0
    assert res == {"text": "ok", "url": "u"}
    assert elapsed < 1.0, "healthy command returns on resolve, not at the timeout"
