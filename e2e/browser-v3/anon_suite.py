"""Popular sites whose composer is published to ANONYMOUS users.

The known suite is nine login-gated sites, so on any box without live sessions its reach denominator
is zero and criterion 1 cannot be scored at all -- which is exactly what happened on 2026-08-06,
where 8 of 9 known sites were signed out and the suite measured nothing. Session state is an account
fact, not a product fact, and a benchmark that can only run on one person's logged-in profile is not
reproducible by anyone else.

This suite fixes that: every host below serves a real editable composer with no account, so a miss is
always OUR miss and never a session state. It is a COMPLEMENT to the known suite, never a replacement
-- the login-gated sites test flows (opener clicks, lazily-mounted overlays, DM-vs-post disambiguation)
that these do not, so the original TASKS stay exactly as they were and both are reported separately.

Selection rules, so this cannot quietly become a suite we tuned against:
  - No host that appears in HOLDOUT. Checked by `assert_disjoint_from_holdout` at import.
  - Shape spread on purpose: plain textarea, rich contenteditable, CodeMirror, ACE, wikitext.
    A suite of only textareas would flatter us; the known suite's wins are nearly all contenteditable.
  - Reach only, in dry run. Nothing here is ever submitted, and none of these pages is a real
    account surface, so a dry sweep leaves no trace at all.
"""

# Popular, anonymous, and shape-diverse. The task wording carries the payload in quotes because the
# send-script requires a quoted payload to arm at all; dry mode stops before the irreversible click.
ANON = {
    "gtranslate": 'Go to translate.google.com and type "coverage probe alpha" into the source text box',
    "deepl":      'Go to deepl.com/translator and type "coverage probe alpha" into the source text box',
    "w3schools":  'Go to w3schools.com/html/tryit.asp?filename=tryhtml_default and write '
                  '"coverage probe alpha" in the code editor',
    "wikisandbox": 'Go to en.wikipedia.org/wiki/Wikipedia:Sandbox?action=edit and write '
                   '"coverage probe alpha" in the edit box',
    "regex101":   'Go to regex101.com and write "coverage probe alpha" in the test string box',
    "onlinegdb":  'Go to onlinegdb.com and write "coverage probe alpha" in the code editor',
}

# The page each task must END on, same contract as coverage.ON_PAGE: reaching *a* box is not reach,
# reaching THE box on THE surface is.
ANON_PAGE = {
    "gtranslate":  r"translate\.google\.com",
    "deepl":       r"deepl\.com",
    "w3schools":   r"w3schools\.com",
    "wikisandbox": r"wikipedia\.org/w/index\.php|wikipedia\.org/wiki/Wikipedia:Sandbox",
    "regex101":    r"regex101\.com",
    "onlinegdb":   r"onlinegdb\.com",
}

# What each host is here to exercise, so a per-shape reading is possible rather than one aggregate.
ANON_SHAPE = {
    "gtranslate": "plain textarea", "deepl": "rich contenteditable",
    "w3schools": "textarea in a framed editor", "wikisandbox": "wikitext textarea",
    "regex101": "CodeMirror", "onlinegdb": "ACE editor",
}


def assert_disjoint_from_holdout(holdout_hosts) -> None:
    """A known-suite host that is also a holdout host burns the holdout, because everything we fix
    against the first is by definition tuned against the second. Checked in code rather than trusted
    to review: this file and HOLDOUT are edited months apart by people who cannot see each other."""
    overlap = set(ANON) & set(holdout_hosts)
    if overlap:
        raise AssertionError(
            f"anon suite overlaps the frozen holdout on {sorted(overlap)}; "
            "that burns the holdout, pick different hosts")
