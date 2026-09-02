"""A deliberate stop() must not leave is_running() answering True from its cache.

The 10s positive cache in is_running() exists so a busy router isn't misread as dead. Three paths
kill the router; death_watch and the dev stale-kill branch both drop the cache, but stop() (the
DELIBERATE kill) did not, and it cancels the death watcher first so nothing could cover for it.

Live consequence, packaged 1.7.10-exp.2, 2026-08-31: bounce_router_after_connect ran stop() ->
ensure_running(), the cached True made ensure_running log "9Router already running" and start
nothing, and the bounce then returned is_running() == True. The router was down 22s, every CLI that
connected in that window deferred its MCP tools, and the first ToolSearch load 400'd the turn
(ENG-394) after 61 tool calls of real work.
"""
import time

import pytest

from backend.apps.nine_router import process as rp


@pytest.fixture(autouse=True)
def p_restore():
    before = (rp.p_is_running_last_ok, rp.p_process, rp.watchdog_task, rp.p_death_watcher_task)
    yield
    (rp.p_is_running_last_ok, rp.p_process, rp.watchdog_task, rp.p_death_watcher_task) = before


def p_arm_cache_and_kill_port(monkeypatch):
    """Cache says 'up'; the port is dead. Only the cache can produce a True now."""
    def p_refuse(*a, **k):
        raise OSError("connection refused")
    monkeypatch.setattr(rp.socket, "create_connection", p_refuse)
    rp.p_is_running_last_ok = time.monotonic()
    rp.p_process = None
    rp.watchdog_task = None
    rp.p_death_watcher_task = None


def test_the_cache_is_what_makes_this_test_meaningful(monkeypatch):
    """Control: with the cache armed and the port dead, is_running() DOES lie. If this ever fails
    the cache is gone and the rest of the file proves nothing."""
    p_arm_cache_and_kill_port(monkeypatch)
    assert rp.is_running() is True


def test_stop_clears_the_cache_so_a_dead_router_reads_as_dead(monkeypatch):
    p_arm_cache_and_kill_port(monkeypatch)
    rp.stop()
    assert rp.is_running() is False, "stop() left is_running() answering True on a dead port"


def test_stop_clears_the_cache_before_it_touches_anything_else():
    """Ordering, not just behaviour: an edit that moves the reset below an early return, or into one
    of the branches, fails here rather than shipping."""
    import inspect
    src = inspect.getsource(rp.stop)
    reset = src.index("p_is_running_last_ok = 0.0")
    first_branch = src.index("if watchdog_task is not None")
    assert reset < first_branch, "the cache reset must sit above every branch in stop()"


@pytest.mark.asyncio
async def test_a_bounce_cannot_report_success_after_killing_the_router(monkeypatch):
    """The row-6 half: the bounce used to return True having started nothing."""
    from backend.apps.nine_router import bounce_after_connect as bac

    p_arm_cache_and_kill_port(monkeypatch)
    started: list[bool] = []

    async def p_ensure():
        # A real ensure_running only starts when is_running() is False; mirror that decision here.
        if not rp.is_running():
            started.append(True)

    monkeypatch.setattr(rp, "ensure_running", p_ensure)
    monkeypatch.setattr(bac.router_process, "ensure_running", p_ensure)
    monkeypatch.setattr(bac.asyncio, "sleep", lambda *p_a, **p_k: p_noop())

    async def p_noop():
        return None

    ok = await bac.bounce_router_after_connect("claude")
    assert started == [True], "the bounce skipped the restart because the cache still said 'up'"
    assert ok is False, "the bounce claimed success while the router was down"
