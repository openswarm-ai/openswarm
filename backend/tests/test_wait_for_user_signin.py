"""The ENG-279 sign-in pause: a hard login wall with nothing to borrow hands off to the human at
the browser card and resumes itself. The dangerous edges are (1) resuming on an OAuth redirect
interstitial (one wall-free poll is not signed in), (2) never ending (deadline must hold), and
(3) outliving a Stop (cancel must win instantly)."""

import asyncio

import pytest

from backend.apps.agents.browser import wait_for_user_signin as w


WALL = ("https://x.com/i/flow/login", "Sign in to X\nPassword")
CLEAR = ("https://x.com/home", "Home\nFor you\nFollowing\nPost")


def p_probe_from(seq):
    it = iter(seq)
    last = seq[-1]

    async def probe():
        return next(it, last)
    return probe


@pytest.mark.asyncio
async def test_two_clear_polls_resume(monkeypatch):
    monkeypatch.setattr(w, "POLL_SECONDS", 0.01)
    monkeypatch.setattr(w, "MAX_WAIT_SECONDS", 5.0)
    ok = await w.wait_for_user_signin("x.com", p_probe_from([WALL, WALL, CLEAR, CLEAR]), asyncio.Event())
    assert ok is True


@pytest.mark.asyncio
async def test_one_clear_poll_is_not_signed_in(monkeypatch):
    # An OAuth redirect interstitial matches no wall for a beat; a single clear poll must not resume.
    monkeypatch.setattr(w, "POLL_SECONDS", 0.01)
    monkeypatch.setattr(w, "MAX_WAIT_SECONDS", 0.3)
    ok = await w.wait_for_user_signin("x.com", p_probe_from([WALL, CLEAR, WALL, CLEAR, WALL]), asyncio.Event())
    assert ok is False, "alternating clear/wall must never satisfy the two-in-a-row rule"


@pytest.mark.asyncio
async def test_deadline_holds_when_user_never_signs_in(monkeypatch):
    monkeypatch.setattr(w, "POLL_SECONDS", 0.01)
    monkeypatch.setattr(w, "MAX_WAIT_SECONDS", 0.15)
    t0 = asyncio.get_running_loop().time()
    ok = await w.wait_for_user_signin("x.com", p_probe_from([WALL]), asyncio.Event())
    assert ok is False
    assert asyncio.get_running_loop().time() - t0 < 2.0


@pytest.mark.asyncio
async def test_cancel_wins_instantly(monkeypatch):
    monkeypatch.setattr(w, "POLL_SECONDS", 30.0)
    monkeypatch.setattr(w, "MAX_WAIT_SECONDS", 300.0)
    ev = asyncio.Event()

    async def cancel_soon():
        await asyncio.sleep(0.05)
        ev.set()
    task = asyncio.create_task(cancel_soon())
    t0 = asyncio.get_running_loop().time()
    ok = await w.wait_for_user_signin("x.com", p_probe_from([WALL]), ev)
    await task
    assert ok is False
    assert asyncio.get_running_loop().time() - t0 < 2.0, "a Stop must not wait out the poll interval"


@pytest.mark.asyncio
async def test_probe_failure_reads_as_still_walled(monkeypatch):
    monkeypatch.setattr(w, "POLL_SECONDS", 0.01)
    monkeypatch.setattr(w, "MAX_WAIT_SECONDS", 0.15)

    async def broken_probe():
        raise RuntimeError("webview gone")
    ok = await w.wait_for_user_signin("x.com", broken_probe, asyncio.Event())
    assert ok is False
