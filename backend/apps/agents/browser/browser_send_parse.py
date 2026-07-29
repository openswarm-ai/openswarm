"""Pure perception-parsing for the staged send: read the browser's interactives listing + the
user's task and answer the structural questions the send orchestration needs, with no I/O and no
side effects. What quoted payload did the user name? Which listed row is the compose box / the
opener? Is this a login wall or a read-only request the script must decline? One host-agnostic
shape per question, so the same logic generalizes across X/Reddit/LinkedIn/Gmail/Slack/etc.

Lives BELOW browser_send_script (which orchestrates the fill/click/verify tail): send_script
imports from here, never the reverse.
"""

import re

# Double quotes are unambiguous. Single quotes only delimit when the opener is at a word boundary (start/space/colon), so an in-word apostrophe like "chen's" is never mistaken for a payload quote, that mispairing was silently corrupting the canonical "text him '...'" errand.
P_QUOTED_DQ_RE = re.compile(r'"([^"]{4,300})"')
P_QUOTED_SQ_RE = re.compile(r"(?:^|[\s:>])'([^']{4,300})'")
P_COMPOSER_ROW_RE = re.compile(r"\[(\d+)\]\*?<\s*textbox\s+\"([^\"]*)\"", re.I)
# A compose-shaped textbox name, generalized across messaging sites: LinkedIn "Write a
# message", X/Slack "Message", Discord "Message @user", Gmail "Message Body", "Post your
# reply", "What's happening", "Add a comment". Not per-site: one structural shape.
P_COMPOSER_NAME_RE = re.compile(
    r"write|messag|compose|reply|comment|post your|post text|what.?s happening|"
    r"tweet|caption|say something|start a|new message|body|your (message|note)|"
    r"add a comment|write something",
    re.I,
)

# Login/auth walls: a logged-out card lands here, and the structural reveal-finder would
# otherwise fill a login field and arm the page's own submit as a "send" (measured live on
# instagram/threads). A real composer never lives on one of these, so decline outright.
P_LOGIN_WALL_URL_RE = re.compile(
    r"accounts\.google\.com|/i/flow/login|/accounts/login|/uas/login|/users/sign_in|"
    r"/sessions/new|/checkpoint|force_authentication|"
    r"/(?:log[_-]?in|sign[_-]?in|signin|logon)(?:[/?#]|$)",
    re.I,
)
P_LOGIN_WALL_STATE_RE = re.compile(
    r'<\s*textbox\s+"[^"]*(?:password|passwd)|(?:log|sign)\s?in to |'
    r"continue with (?:google|apple|facebook)",
    re.I,
)

P_OPENER_ROW_RE = re.compile(
    r"\[(\d+)\]\*?<\s*(?:link|button)\s+\"(Message|Reply|Compose|New message|"
    r"Direct message|DM|Send message|Write|New chat|Comment|Post)\"", re.I)

# A verification probe quotes the very payload it's checking for, which is exactly the trap this gate exists for: quoted payload + composer = fire. Caught live (r243): the read-only send-probe delivered a REAL message. Read-only directives decline in code, fail-safe (a false match just means the model path).
P_READONLY_RE = re.compile(
    r"read.?only|do\s+not\s+(?:send|type|click|post|submit|change|edit|delete)|"
    r"don'?t\s+(?:send|post|submit|change|edit|delete)|"
    # "verify/check/tell me/say/confirm WHETHER x is there" is the whole family, not two phrasings
    # of it. Measured: "say whether anything containing <quoted text> is still there. Change
    # nothing." slipped through and POSTED the quoted text to a real LinkedIn feed, because only
    # "verify whether" and "check whether" were listed. Anchor on the question shape.
    r"(?:verify|check|confirm|tell\s+me|say|see|find\s+out|look)\s+(?:me\s+)?(?:if|whether)|"
    r"is\s+(?:it|there|this|that)\s+(?:still\s+)?(?:there|published|posted|live|present)|"
    r"still\s+(?:there|published|posted|live|up)|"
    r"change\s+nothing|without\s+(?:sending|posting|changing)|verification",
    re.I,
)


def looks_like_login_wall(current_url: str, state_text: str) -> bool:
    """A login/auth page (by URL) or an auth form in the perception (a password field, a
    'Log in to X' heading, an OAuth 'Continue with ...'). The scripted send declines here:
    a real composer never shares a page with these, and filling here types a login field."""
    if current_url and P_LOGIN_WALL_URL_RE.search(current_url):
        return True
    return bool(state_text and P_LOGIN_WALL_STATE_RE.search(state_text))


# SOFT signed-out: the site serves a browsable page with no auth form and no login URL, it just
# withholds the composer and offers a "Sign in" control (bsky, stackoverflow, tiktok, threads all
# behave this way). The hard-wall gate above sees nothing, so the run used to report "I couldn't
# find the compose box" when the truth was "you are not signed in", which is a different problem
# with a different fix. Only ever consulted AFTER a composer miss, so it cannot affect a success.
P_SIGNIN_AFFORDANCE_RE = re.compile(
    r'<\s*(?:link|button)\s+"[^"]*(?:sign[_ -]?in|log[_ -]?in|sign[_ -]?up|create account|join now)',
    re.I)
# Anything only a signed-IN page shows. Its presence vetoes the verdict, so a stray "Log in" on an
# authenticated page (a second product's promo) can't make us tell the user to sign in again.
# Deliberately NARROW: an earlier draft also vetoed on "notifications"/"profile"/"inbox", which
# logged-OUT pages advertise all the time, and that silently suppressed the whole detector on the
# exact sites it exists for (measured: bsky with 0 cookies read as signed-in). Only a control that
# is meaningless unless you are already authenticated belongs here.
P_SIGNED_IN_RE = re.compile(
    r'(?:sign|log)[_ -]?out\b|your profile|account menu|my account',
    re.I)


def looks_signed_out(state_text: str) -> bool:
    """True when the page offers a way to sign IN and shows nothing only a signed-in user sees."""
    if not state_text:
        return False
    if P_SIGNED_IN_RE.search(state_text):
        return False
    return bool(P_SIGNIN_AFFORDANCE_RE.search(state_text))


# Creating a POST and commenting on someone else's are different actions on different content.
# LinkedIn's feed carries a comment box on EVERY post, and the capped interactives listing routinely
# starves the real post modal of its own composer, so the only compose-shaped textbox left in the
# list is a stranger's comment box. Filling that is not a slower path to the same place, it is the
# wrong action on the wrong person's content. Measured in a dry-run sweep: linkedin reached its
# composer 1/4, and two of the three misses targeted 'Text editor for creating comment'.
P_POST_INTENT_RE = re.compile(r"\b(post|tweet|publish|share)\b", re.I)
P_COMMENT_INTENT_RE = re.compile(r"\b(comment|reply|respond)\b", re.I)
P_COMMENT_SURFACE_RE = re.compile(r"\b(comment|reply)\b", re.I)


def surface_mismatch(task: str, composer_name: str) -> bool:
    """True when the task asks to create a POST but the composer found is a comment/reply box.

    Deliberately one-directional: a task that mentions commenting is left alone, so this can only
    ever reject a comment box for a post task, never the reverse. A rejection is cheap (the
    structural finder, which does find LinkedIn's real composer, gets its turn instead)."""
    t, name = task or "", composer_name or ""
    if not P_POST_INTENT_RE.search(t) or P_COMMENT_INTENT_RE.search(t):
        return False
    return bool(P_COMMENT_SURFACE_RE.search(name))


def is_readonly(text: str) -> bool:
    """A read-only directive ('verify whether', 'do not send') that must decline the scripted
    send even with a quoted payload in hand. Keeps the regex private to this file."""
    return bool(text and P_READONLY_RE.search(text))


def quoted_payload(task: str) -> str:
    """The exact text the user quoted, only when it's unambiguous: exactly one
    distinct quoted span in the task. Anything else is the model's judgment call.
    Double quotes win outright; single quotes must be word-boundary-delimited so
    an apostrophe inside a name can't hijack the match."""
    dq = {m.group(1).strip() for m in P_QUOTED_DQ_RE.finditer(task or "") if m.group(1).strip()}
    if dq:
        return dq.pop() if len(dq) == 1 else ""
    sq = {m.group(1).strip() for m in P_QUOTED_SQ_RE.finditer(task or "") if m.group(1).strip()}
    return sq.pop() if len(sq) == 1 else ""


def opener_index_in_state(state_text: str):
    """(index, name) of the single exact-named composer OPENER, or None. Exact
    names only, so an upsell like 'Send InMail' can never match."""
    hits = [(int(m.group(1)), m.group(2)) for m in P_OPENER_ROW_RE.finditer(state_text or "")]
    return hits[0] if len(hits) == 1 else None


def composer_index_in_state(state_text: str):
    """(index, name) of the single compose-shaped textbox, or None. Two
    candidates = ambiguous = model's problem."""
    hits = [(int(m.group(1)), m.group(2)) for m in P_COMPOSER_ROW_RE.finditer(state_text or "")
            if P_COMPOSER_NAME_RE.search(m.group(2) or "")]
    return hits[0] if len(hits) == 1 else None


def textbox_count(state_text: str) -> int:
    """How many textboxes the perception listed, compose-shaped or not.

    Diagnostic only, and only meaningful next to a failed composer pick: zero means the page never
    mounted one, several means the picker refused an ambiguous choice. Those are different bugs."""
    return len(P_COMPOSER_ROW_RE.findall(state_text or ""))


def surface_supports_script(current_url: str, state_text: str = "") -> bool:
    """STRUCTURAL, not per-site: fire wherever the live perception actually carries a
    person-composer (a compose-shaped textbox) OR a single messaging opener to reach
    one, on ANY host. This is what generalizes the LinkedIn ~14s send to X/Slack/
    Discord/Instagram/Gmail/etc without per-site URL gates. A page with neither
    declines (net-negative to fire where there's no composer). All the downstream
    safety gates (quoted payload, fill-seen-committed before the one send, two-sided
    receipt) are already site-agnostic, so widening the surface can't loosen safety."""
    if not state_text:
        return False
    return bool(composer_index_in_state(state_text) or opener_index_in_state(state_text))


def dryrun_report(state_text: str, armed: bool, filled: bool, url: str = "") -> str:
    """One grep-stable line for the coverage harness: what the staged perception held
    and how far the script got. Only ever emitted in dry-run measurement mode."""
    boxes = len(P_COMPOSER_ROW_RE.findall(state_text or ""))
    return (f"[dryrun-report] armed={int(bool(armed))} "
            f"composer={int(bool(composer_index_in_state(state_text or '')))} "
            f"opener={int(bool(opener_index_in_state(state_text or '')))} "
            f"textboxes={boxes} filled={int(bool(filled))} url={(url or '')[:120]}")
