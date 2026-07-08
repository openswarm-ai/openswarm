"""Generic, site-agnostic verification: did an action produce the SPECIFIC effect
it was meant to? This is the load-bearing piece that lets a verified-action executor
work on any website without per-site code, the model (or a scripted flow) names a
generic expectation, and this checks it against a cheap before/after page snapshot.

A snapshot is just the interactives-list text plus the URL, the same things every
site exposes, so nothing here knows about LinkedIn or any particular page. It
generalizes the send-script's proven two-sided receipt ("the composer cleared") from
one hand-tuned flow into one predicate ("cleared:<text>") reusable everywhere.

Expectations (kind, or "kind:arg"):
  url_changed    the page navigated
  changed        the page changed at all (weakest; a fallback)
  appeared:X     X is present now but wasn't before (a menu/dialog/result opened)
  gone:X         X was present before but isn't now (an item/row deleted)
  filled:X       some textbox value now carries X (a fill committed)
  cleared:X      no textbox value carries X (a composer sent + emptied)
"""

import re
from typing import Tuple

# Match payload_in_textbox: long values truncate in the list, so compare on a prefix.
P_VALUE_PREFIX_LEN = 24
P_TEXTBOX_LINE = "<textbox"


def parse_expectation(expect: str) -> Tuple[str, str]:
    """(kind, arg) from 'kind' or 'kind:arg'. Unknown kinds are returned as-is and
    treated as unmet by expectation_met, so a typo fails safe (verification withheld)."""
    raw = (expect or "").strip()
    if ":" in raw:
        kind, arg = raw.split(":", 1)
        return kind.strip().lower(), arg.strip()
    return raw.lower(), ""


def value_present(state_text: str, sub: str) -> bool:
    """True if any listed textbox VALUE carries sub (prefix match, like a committed
    fill). Same logic as payload_in_textbox so the send-script stays behavior-identical."""
    probe = (sub or "")[:P_VALUE_PREFIX_LEN]
    if not probe:
        return False
    return any(P_TEXTBOX_LINE in line and probe in line
               for line in (state_text or "").splitlines())


def p_contains(state_text: str, sub: str) -> bool:
    s = (sub or "").strip().lower()
    return bool(s) and s in (state_text or "").lower()


def expectation_met(
    expect: str, before: str, after: str,
    before_url: str = "", after_url: str = "",
) -> bool:
    """Did `after` satisfy `expect` given `before`? Pure; unknown expectation = False
    (fail safe: verification withheld rather than a false pass)."""
    kind, arg = parse_expectation(expect)
    if kind == "url_changed":
        return bool(after_url) and after_url != before_url
    if kind == "changed":
        return before != after or (bool(after_url) and after_url != before_url)
    if kind == "appeared":
        return p_contains(after, arg) and not p_contains(before, arg)
    if kind == "gone":
        return p_contains(before, arg) and not p_contains(after, arg)
    if kind == "filled":
        return value_present(after, arg)
    if kind == "cleared":
        return not value_present(after, arg)
    return False
