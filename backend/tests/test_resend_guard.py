"""An irreversible send that ran must never run twice, proven or not.

Measured live on LinkedIn 2026-08-04. The post LANDED (an independent read of the activity feed
found it), our two-sided receipt did not see the composer clear, and the model then re-typed into
the SAME composer. The stranded post read `canary20ef2f39canary20ef2f39`: the payload, twice.

The cause was one flag doing two jobs. `send_confirmed` answered both "may we claim delivery?" and
"has a send already gone out?", and at this exact moment those have opposite answers: the click ran
(so re-sending is wrong) but nothing proved it landed (so claiming is wrong). The code chose to keep
claiming honest, and the comment asserted "never a blind resend" without anything enforcing it.

`p_send_clicked` is now the resend guard and arms on the CLICK; `send_confirmed` stays the evidence
flag and still needs proof. Every path that confirms a send also arms the guard, because a confirmed
send is by definition one that ran.
"""

import inspect
import re

from backend.apps.agents.browser import browser_agent as BA

SRC = inspect.getsource(BA)


def test_the_guard_is_a_separate_flag_from_the_evidence_flag():
    """If these ever collapse back into one, the bug returns exactly as it was."""
    assert "p_send_clicked = False" in SRC, "the resend guard must exist"
    assert "send_confirmed = False" in SRC, "the evidence flag must still exist"


def test_an_unverified_send_still_arms_the_guard():
    """The precise LinkedIn case: clicked, receipt missed. Claiming stays off, resending stays shut."""
    i = SRC.index("Clicked but the composer did NOT clear")
    branch = SRC[i:i + 1400]
    assert "p_send_clicked = True" in branch, "a click that ran must arm the guard even unproven"
    assert "send_confirmed = True" not in branch, "an unproven send must never claim delivery"


def test_the_autosend_click_path_checks_the_guard():
    """This is the path that re-clicked Send. It must ask "has one run?", not "did one prove?"."""
    i = SRC.index("browser_send_script.autosend_enabled()):")
    guard = SRC[max(0, i - 700):i]
    assert "not p_send_clicked" in guard


def test_every_confirmed_send_also_arms_the_guard():
    """A confirmed send is a send that ran, so the two must never drift apart again."""
    confirms = [m.start() for m in re.finditer(r"send_confirmed = True", SRC)]
    assert len(confirms) >= 4, f"expected the known confirm sites, found {len(confirms)}"
    for pos in confirms:
        window = SRC[pos:pos + 260]
        assert "p_send_clicked = True" in window, f"a confirm at offset {pos} does not arm the guard"
