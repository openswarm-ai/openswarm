"""Smart wait: return when the page's network settles, not on a blind timer.

The wait runs on EVERY browser task and the audit says it's 42% of all time, so
this is high-blast-radius. These pin down that it (1) returns early when settled,
(2) never returns before the floor (no half-loaded reads), (3) never exceeds the
cap, (4) keeps waiting through a still-loading SPA, (5) survives a cancel or a
mid-navigation probe error. Edge-case-complete on purpose.
"""

import asyncio
import json
import time

import pytest

from backend.apps.agents.browser import browser_wait as bw


# --- the pure decision (hammer it) ------------------------------------------
def test_decide_stop_waits_until_past_the_floor():
    # even a fully-settled page must not return before the floor (a momentary gap between two requests would otherwise look 'settled')
    assert bw.decide_stop(True, 9999, 0, False, 100, floor_ms=250) is False
    assert bw.decide_stop(True, 9999, 0, False, 300, floor_ms=250) is True


def test_decide_stop_needs_ready_and_quiet():
    # past floor, but document not complete -> keep waiting
    assert bw.decide_stop(False, 9999, 9999, False, 500) is False
    # past floor, ready, but neither network nor DOM quiet long enough -> wait
    assert bw.decide_stop(True, 100, 100, False, 500, settle_window_ms=400) is False
    # past floor, ready, network quiet long enough -> stop
    assert bw.decide_stop(True, 400, 0, False, 500, settle_window_ms=400) is True


def test_decide_stop_target_found_short_circuits_everything():
    # the target is present -> stop NOW, even before the floor and with a busy network
    assert bw.decide_stop(False, 0, 0, True, 10) is True


def test_decide_stop_dom_settle_when_network_never_idles():
    # beacon-heavy SPA: network never idle (quiet tiny) but the DOM has stopped -> stop
    assert bw.decide_stop(True, 5, 400, False, 600, settle_window_ms=400) is True


def test_decide_stop_handles_missing_signals():
    assert bw.decide_stop(True, None, None, False, 500) is False


# --- the async loop with a scripted probe -----------------------------------
def p_probe(ready, quiet, elems=1000, found=False):
    return {"text": json.dumps({"ready": ready, "quiet": quiet, "elems": elems, "found": found}),
            "url": "https://x.com"}


class FakeExec:
    """Returns scripted probe results in sequence (last one repeats)."""
    def __init__(self, results):
        self.results = results
        self.calls = 0

    async def __call__(self, tool, params, bid, tid):
        assert tool == "BrowserEvaluate"
        r = self.results[min(self.calls, len(self.results) - 1)]
        self.calls += 1
        return r


class HangingExec:
    """Simulates a wedged tab: every probe blocks far longer than the probe
    timeout (like the underlying 30s command timeout on a hung page)."""
    def __init__(self, block_s=5.0):
        self.block_s = block_s
        self.calls = 0

    async def __call__(self, tool, params, bid, tid):
        self.calls += 1
        await asyncio.sleep(self.block_s)
        return p_probe(False, 0)


@pytest.mark.asyncio
async def test_returns_early_once_settled():
    # first probe: still loading; second: settled -> should stop well under the cap
    ex = FakeExec([p_probe(False, 0), p_probe(True, 999)])
    out = await bw.smart_wait(ex, "b", "", 5000, poll_ms=20, floor_ms=20, quiet_window_ms=50)
    assert out["settled"] is True and out["found"] is False
    assert out["waited_ms"] < 5000
    assert "page settled" in out["text"]


@pytest.mark.asyncio
async def test_rides_to_cap_when_page_never_settles():
    # an SPA that keeps fetching (quiet always small) -> never settles -> caps out
    ex = FakeExec([p_probe(True, 10)])
    out = await bw.smart_wait(ex, "b", "", 200, poll_ms=20, floor_ms=20, quiet_window_ms=400)
    assert out["settled"] is False
    assert out["waited_ms"] >= 180  # ~the cap
    assert "reached cap" in out["text"]


@pytest.mark.asyncio
async def test_settles_on_dom_stable_when_network_never_idles():
    # the LinkedIn case: network always busy (quiet tiny) but the DOM count is constant -> DOM-settle fires instead of riding to the cap
    ex = FakeExec([p_probe(True, 5, elems=500)])
    out = await bw.smart_wait(ex, "b", "", 3000, poll_ms=20, floor_ms=20, quiet_window_ms=200)
    assert out["settled"] is True and out["waited_ms"] < 3000
    assert "page settled" in out["text"]


@pytest.mark.asyncio
async def test_returns_the_instant_target_is_found():
    # network busy AND DOM churning, but the agent's target appears on probe 2 -> stop immediately, bypassing even the floor
    ex = FakeExec([p_probe(False, 5, elems=100, found=False),
                   p_probe(False, 5, elems=200, found=True)])
    out = await bw.smart_wait(ex, "b", "", 5000, until="Send",
                              poll_ms=20, floor_ms=800, quiet_window_ms=999)
    assert out["settled"] is True and out["found"] is True and "found target" in out["text"]
    assert out["waited_ms"] < 800  # bypassed the floor because the target was there


@pytest.mark.asyncio
async def test_never_returns_before_the_floor():
    # settled from the very first probe, but the floor must still be respected
    ex = FakeExec([p_probe(True, 9999)])
    out = await bw.smart_wait(ex, "b", "", 5000, poll_ms=10, floor_ms=200, quiet_window_ms=50)
    assert out["waited_ms"] >= 200, "must not read a page before the settle floor"
    assert out["settled"] is True


@pytest.mark.asyncio
async def test_cancel_mid_wait_stops_cleanly():
    async def p_cancelled(tool, params, bid, tid):
        return None  # _cancellable returns None when the run is cancelled
    out = await bw.smart_wait(p_cancelled, "b", "", 5000, poll_ms=10, floor_ms=10)
    assert out["settled"] is False and out["waited_ms"] < 5000


@pytest.mark.asyncio
async def test_probe_error_during_navigation_keeps_waiting_then_settles():
    # while the page is navigating, evaluate errors; we must keep polling, not bail
    ex = FakeExec([{"error": "Cannot evaluate, page navigating"},
                   {"error": "still navigating"},
                   p_probe(True, 999)])
    out = await bw.smart_wait(ex, "b", "", 5000, poll_ms=15, floor_ms=15, quiet_window_ms=50)
    assert out["settled"] is True and ex.calls >= 3


@pytest.mark.asyncio
async def test_garbage_probe_text_does_not_crash():
    ex = FakeExec([{"text": "not json", "url": "u"}, p_probe(True, 999)])
    out = await bw.smart_wait(ex, "b", "", 3000, poll_ms=15, floor_ms=15, quiet_window_ms=50)
    assert out["settled"] is True


@pytest.mark.asyncio
async def test_hung_tab_returns_fast_not_after_the_full_command_timeout():
    # THE bug from the 20-min loop: a wedged tab made each 'wait' block ~30s. Now each probe is bounded, so after a couple of timeouts it returns hung, in a few seconds, NOT 30s+, regardless of how long the command would block.
    ex = HangingExec(block_s=30.0)  # mimic the 30s command timeout
    t0 = time.monotonic()
    out = await bw.smart_wait(ex, "b", "", 8000, poll_ms=20, probe_timeout_s=0.3)
    elapsed = time.monotonic() - t0
    assert out["hung"] is True, "a non-responding tab must be flagged hung"
    assert out.get("error") == "page unresponsive"
    assert elapsed < 3.0, f"hung wait must return fast, took {elapsed:.1f}s"
    # it bailed after the timeout threshold, not after burning the whole cap
    assert ex.calls <= bw.MAX_PROBE_TIMEOUTS


@pytest.mark.asyncio
async def test_a_single_slow_probe_then_settle_is_not_flagged_hung():
    # one slow probe (under the threshold count) shouldn't trip 'hung'; it recovers
    class p_OneSlow:
        def __init__(self): self.n = 0
        async def __call__(self, *a):
            self.n += 1
            if self.n == 1:
                await asyncio.sleep(0.5)   # one slow poll
                return p_probe(False, 0)
            return p_probe(True, 999)
    out = await bw.smart_wait(p_OneSlow(), "b", "", 5000, poll_ms=10, floor_ms=10,
                              quiet_window_ms=50, probe_timeout_s=0.2)
    assert out["hung"] is False and out["settled"] is True
