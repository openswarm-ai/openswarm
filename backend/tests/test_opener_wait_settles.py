"""When to stop waiting for a compose surface that was just opened.

Split out of test_browser_send_script.py, which hit the 300-line cap. The rule under test is its
own idea and deserves its own file: a fixed wait was wrong in both directions (1.8s missed gmail
and linkedin; 5.3s still missed a cold gmail compose window; raising it further taxes every run
that was never going to succeed), so the stop condition is page stability instead of a clock.
"""
import pytest

from backend.tests.test_browser_send_script import (
    COMPOSER_EMPTY, COMPOSER_FILLED, COMPOSER_SENT, PROFILE, TASK, run,
)

@pytest.mark.asyncio
async def test_opener_wait_stops_once_the_surface_settles():
    """A budget spent waiting on a page that has stopped changing is pure cost.

    Fixed budgets were wrong in both directions: 1.8s missed gmail and linkedin, 5.3s still missed
    a cold gmail compose window, and just raising the number taxes every run that was never going
    to work. The stop condition is now page stability, so an opener that leads nowhere gives up as
    soon as two reads match instead of sleeping out the rest."""
    # Opener clicked, then the same composer-less page twice: identical reads = nothing coming.
    r, calls = await run(TASK, PROFILE, [PROFILE, PROFILE, PROFILE, PROFILE, PROFILE, PROFILE])
    assert r is None
    # 6 sleeps were budgeted; settling must cut the reads well short of consuming them all.
    assert calls["list"] < 9, f"kept polling a settled page: {calls['list']} reads"


@pytest.mark.asyncio
async def test_opener_wait_still_catches_a_late_composer():
    """The other direction: a surface that is still mounting must not be abandoned early, which is
    the failure that made gmail intermittent."""
    # Changing reads (so never 'settled'), composer only on the 4th look.
    late = [PROFILE, PROFILE, PROFILE, PROFILE + "\n[99]<button \"x\">",
            COMPOSER_EMPTY, COMPOSER_FILLED, COMPOSER_SENT]
    r, calls = await run(TASK, PROFILE, late)
    assert r is not None and r["sent"] is True
