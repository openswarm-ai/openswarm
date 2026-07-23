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
    r"read.?only|do\s+not\s+(?:send|type|click|post|submit)|don'?t\s+(?:send|post|submit)|"
    r"verify\s+whether|check\s+whether|verification",
    re.I,
)


def looks_like_login_wall(current_url: str, state_text: str) -> bool:
    """A login/auth page (by URL) or an auth form in the perception (a password field, a
    'Log in to X' heading, an OAuth 'Continue with ...'). The scripted send declines here:
    a real composer never shares a page with these, and filling here types a login field."""
    if current_url and P_LOGIN_WALL_URL_RE.search(current_url):
        return True
    return bool(state_text and P_LOGIN_WALL_STATE_RE.search(state_text))


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
