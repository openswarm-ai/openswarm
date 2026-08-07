"""Every literal this harness greps for must exist in the code that is supposed to print it.

Written after the fourth instance of the same bug. `DELIVERY CONFIRMED` appeared in the canary and
nowhere in the backend. `saw_page` listed two `[browser-action] X` strings that are never emitted.
`replay_full` matched a phrase no logger uses. Each one silently turned a measurement into a
constant, and each cost hours of chasing a product bug that did not exist.

A grep whose needle is absent from the source cannot fail loudly, so make it fail here instead.
"""

import os
import re
import subprocess
import sys

TREE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
HERE = os.path.dirname(os.path.abspath(__file__))
SP = os.path.dirname(HERE)

# (label, literal, where it must appear). A literal is a fixed substring of a real log line, with
# the f-string holes cut out, so it can be checked with a plain fixed-string grep.
MARKERS = [
    # canary receipt detection
    ("receipt/sendscript", "done sent_receipt=", "backend/apps"),
    ("receipt/agent-loop", "two-sided receipt passed", "backend/apps"),
    ("receipt/autosend", "code-send delivered (receipt verified)", "backend/apps"),
    # coverage.py grading
    ("dryrun report", "DRYRUN: WOULD send (fill committed", "backend/apps"),
    ("decline", "[browser-sendscript] decline: ", "backend/apps"),
    ("disabled submit", "is present but DISABLED", "backend/apps"),
    ("fill target", "[browser-sendscript] fill target ", "backend/apps"),
    ("fill errored", "fill errored (", "backend/apps"),
    ("fill tier", "[browser-sendscript] fill ok via ", "backend/apps"),
    ("prestage cost", "[browser-prestage] cost ", "backend/apps"),
    ("login wall", "decline: login/auth wall", "backend/apps"),
    ("signed out", "decline: signed OUT", "backend/apps"),
    ("recovery", "one recovery dispatch", "backend/apps"),
    # coverage.py UNHEALTHY (infrastructure)
    ("router watchdog", "9Router watchdog", "backend/apps"),
    ("router died", "9Router process died", "backend/apps"),
    ("no provider", "No AI provider connected", "backend/apps"),
    ("no dashboard", "dispatch refused: no dashboard", "backend/apps"),
    # bench.py infra buckets
    ("browser timeout", "Browser command timed out", "backend/apps"),
    ("card gone/webview", "not an electron webview", "backend/apps"),
    ("card gone/dashboard", "no dashboard is connected", "backend/apps"),
    ("card gone/unresponsive", "page unresponsive", "backend/apps"),
    ("busy to read", "too busy to read", "frontend/src"),
    # skillstats.py
    ("skill record gate", "record gate: honest=", "backend/apps"),
    ("skill recorded", "-step skill for ", "backend/apps"),
    ("skill re-derived", "re-derived identical ", "backend/apps"),
    ("skill not recorded", "NOT recorded (", "backend/apps"),
    ("skill matched", "skill matched on ", "backend/apps"),
    ("no skill", "no skill for host=", "backend/apps"),
    ("prefix replay", "PREFIX replay: ", "backend/apps"),
    ("replay attempt", "REPLAY attempt: ", "backend/apps"),
    ("replay succeeded", "REPLAY SUCCEEDED in ", "backend/apps"),
    ("replay step failed", "replay step failed (", "backend/apps"),
    ("not replayed", " not replayed: ", "backend/apps"),
    # the honesty marker the packaged smokes also grep for
    ("send-not-verified", "[send clicked, NOT verified]", "backend/apps"),
]


def main() -> int:
    bad = []
    for label, needle, where in MARKERS:
        r = subprocess.run(["grep", "-rF", "--", needle, os.path.join(TREE, where)],
                           capture_output=True, text=True)
        n = len([ln for ln in r.stdout.splitlines() if ln.strip()])
        status = "ok " if n else "DEAD"
        if not n:
            bad.append((label, needle))
        print(f"  {status} {label:<22} x{n:<3} {needle!r}")
    print()
    if bad:
        print(f"{len(bad)} DEAD marker(s): a grep for these can never match, so whatever they")
        print("measure is a constant. Fix the needle or delete the check.")
        for label, needle in bad:
            print(f"  - {label}: {needle!r}")
        return 1
    print(f"all {len(MARKERS)} markers exist in the source that prints them")
    return 0


if __name__ == "__main__":
    sys.exit(main())
