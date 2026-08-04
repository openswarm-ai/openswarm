"""Pure perception-parsing for the staged send: read the browser's interactives listing + the
user's task and answer the structural questions the send orchestration needs, with no I/O and no
side effects. What quoted payload did the user name? Which listed row is the compose box / the
opener? Is this a login wall or a read-only request the script must decline? One host-agnostic
shape per question, so the same logic generalizes across X/Reddit/LinkedIn/Gmail/Slack/etc.

Lives BELOW browser_send_script (which orchestrates the fill/click/verify tail): send_script
imports from here, never the reverse.
"""

import re
from typing import Optional

# Double quotes are unambiguous. Single quotes only delimit when the opener is at a word boundary (start/space/colon), so an in-word apostrophe like "chen's" is never mistaken for a payload quote, that mispairing was silently corrupting the canonical "text him '...'" errand.
P_QUOTED_DQ_RE = re.compile(r'"([^"]{4,300})"')
P_QUOTED_SQ_RE = re.compile(r"(?:^|[\s:>])'([^']{4,300})'")
P_COMPOSER_ROW_RE = re.compile(r"\[(\d+)\]\*?<\s*textbox\s+\"([^\"]*)\"", re.I)
# A compose-shaped textbox name, generalized across messaging sites: LinkedIn "Write a
# message", X/Slack "Message", Discord "Message @user", Gmail "Message Body", "Post your
# reply", "What's happening", "Add a comment". Not per-site: one structural shape.
# "text editor" earns its place from a measurement, not a guess: LinkedIn's post box is named
# "Text editor for creating content" and its comment box "Text editor for creating comment", so
# without it the real composer was invisible while the comment box next to it matched on "comment".
# Landing on LinkedIn's own compose surface listed exactly one textbox and we still scored zero.
# Both shapes match now, and telling them apart is surface_mismatch's job, which already does it.
P_COMPOSER_NAME_RE = re.compile(
    r"write|messag|compose|reply|comment|post your|post text|what.?s happening|"
    r"tweet|caption|say something|start a|new message|body|your (message|note)|"
    r"add a comment|write something|text editor|creating content",
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
# A password box disqualifies the page whoever is signed in: whatever that form is for, typing a
# post into it is wrong. Kept apart from the softer copy below because only this one is absolute.
P_PASSWORD_FIELD_RE = re.compile(r'<\s*textbox\s+"[^"]*(?:password|passwd)', re.I)
# The rest of a sign-in form. A login page is password + these and nothing else; a content page that
# merely carries a header login widget also has a box that is none of them, and that box is the
# whole difference. Named structurally rather than by composer vocabulary on purpose: "New Paste"
# matches no compose word anyone would think to list, and it is still obviously somewhere to write.
P_AUTH_FIELD_NAME_RE = re.compile(
    r"password|passwd|e-?mail|user\s?name|\buser\b|\blogin\b|phone|mobile|"
    r"verification|one.?time|\botp\b|\bcode\b|captcha|security answer",
    re.I,
)
# Wording a login screen uses. Also, unfortunately, wording a signed-IN page uses in its footer and
# its upsells, which is why this half is overridable and the password field is not.
P_LOGIN_WALL_STATE_RE = re.compile(
    r"(?:log|sign)\s?in to |continue with (?:google|apple|facebook)",
    re.I,
)

P_OPENER_ROW_RE = re.compile(
    r"\[(\d+)\]\*?<\s*(?:link|button)\s+\"(Message|Reply|Compose|New message|"
    r"Direct message|DM|Send message|Write|New chat|Comment|Post)\"", re.I)
# Any control whose row we might read, so a name can be tested as a whole rather than anchored.
P_CONTROL_ROW_RE = re.compile(r"\[(\d+)\]\*?<\s*(?:link|button)\s+\"([^\"]*)\"", re.I)
# Openers whose label is a SENTENCE, not a word. tiktok's is `Read or add comments 526 comments`,
# and the exact-name rule above missed it, so a video page with its comment button in plain sight
# scored 0/4 while the aux model clicked at it for 27s. Matched as VERB + NOUN on purpose: that is
# what keeps the exactness the old rule was buying. A bare count ("526 comments") has no verb and a
# paid upsell ("Send InMail") has the wrong noun, so neither can reach a click through here.
P_OPENER_PHRASE_RE = re.compile(
    r"\b(?:add|write|leave|post|start|send|new|create)\s+(?:a\s+|an\s+|your\s+)?"
    r"(?:comment|reply|message|post|note|chat|thread|topic|paste)s?\b", re.I)

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


def login_wall_reason(current_url: str, state_text: str) -> str:
    """WHY this page reads as a login wall, or "" when it does not.

    The bool alone sent a whole site to the model path with nothing to debug against: substack
    declined as a wall on `https://substack.com/` while the account was demonstrably signed in, and
    no amount of staring at the regexes reproduced it. A gate that can silently cost a site its
    entire write path should be able to say which words convinced it."""
    if current_url and P_LOGIN_WALL_URL_RE.search(current_url):
        return f"url: {P_LOGIN_WALL_URL_RE.search(current_url).group(0)}"
    if not state_text:
        return ""
    pw = P_PASSWORD_FIELD_RE.search(state_text)
    if pw:
        # A password field proves a login FORM is on the page, never that the whole page is a wall.
        # pastebin serves its "New Paste" box and a header login widget together, and this gate
        # refused the box sitting right beside it; every site with a header sign-in widget was
        # losing its write path the same way. The disproof is structural: a real login page's
        # editables are ALL auth fields, so one that is neither password nor email/username/OTP is
        # somewhere to write. Counting non-auth boxes rather than matching composer words matters,
        # because "New Paste" matches no compose vocabulary and is still plainly a composer.
        if any(not P_AUTH_FIELD_NAME_RE.search(name or "")
               for _, name in P_COMPOSER_ROW_RE.findall(state_text)):
            return ""
        return f"password field: {pw.group(0)[:60]}"
    soft = P_LOGIN_WALL_STATE_RE.search(state_text)
    if not soft:
        return ""
    # "Sign in to ..." and "Continue with Google" are what a login screen says, and ALSO what a
    # signed-in page's footer, upsell and embedded-content strip say. Treating them as proof cost
    # substack its whole write path. The veto looks_signed_out already trusts settles it: a control
    # that is meaningless unless you are authenticated outranks marketing copy.
    if P_SIGNED_IN_RE.search(state_text):
        return ""
    return f"copy: {soft.group(0)[:60]}"


def looks_like_login_wall(current_url: str, state_text: str) -> bool:
    """A login/auth page (by URL) or an auth form in the perception (a password field, a
    'Log in to X' heading, an OAuth 'Continue with ...'). The scripted send declines here:
    a real composer never shares a page with these, and filling here types a login field."""
    return bool(login_wall_reason(current_url, state_text))


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
# The private-message box is the worst wrong surface there is, because getting it wrong is not a
# failed action, it is the user's words delivered privately to a named stranger. Live sweep, dry
# run: 'write a comment on the first post' walked to instagram.com/<someone>/, took that profile's
# 'Message' opener and filled 'Message...'. Armed, it would have DM'd them.
P_DM_SURFACE_RE = re.compile(r"\b(message|messages|dm)\b", re.I)
P_DM_INTENT_RE = re.compile(r"\b(dm|dms|message|messages|email|e-mail|mail|inbox|chat)\b", re.I)


def surface_mismatch(task: str, composer_name: str) -> bool:
    """True when the composer we found contradicts what the task actually asked for.

    A public ask (post, comment) is contradicted by a DM box, and a post ask is contradicted by a
    comment box. A task that asked for neither is left alone entirely, so 'text tyler hello' still
    gets its message box. Rejecting only ever costs a turn: the structural finder, which does find
    LinkedIn's real composer, gets its go instead."""
    t, name = task or "", composer_name or ""
    p_public = bool(P_POST_INTENT_RE.search(t) or P_COMMENT_INTENT_RE.search(t))
    if p_public and P_DM_SURFACE_RE.search(name) and not P_DM_INTENT_RE.search(t):
        return True
    if not P_POST_INTENT_RE.search(t) or P_COMMENT_INTENT_RE.search(t):
        return False
    return bool(P_COMMENT_SURFACE_RE.search(name))


# What a URL path declares the page to BE. Sites disagree about almost everything, but these path
# segments are near-universal, and each one is the site telling us the content type in its own words.
P_URL_CONTENT_TYPES = (
    ("story", re.compile(r"/stories?/", re.I)),
    ("message", re.compile(r"/(direct|messages?|dm)/", re.I)),
    ("video", re.compile(r"/(watch|shorts)\b|/video/", re.I)),
    ("post", re.compile(r"/(p|posts?|status|submit)/|/submit\b", re.I)),
)
# The same types as the TASK names them. Deliberately narrow: a word has to be unambiguous here or
# the guard starts refusing pages that were right all along.
P_TASK_CONTENT_TYPES = (
    ("story", re.compile(r"\bstor(?:y|ies)\b", re.I)),
    ("message", re.compile(r"\b(dm|direct message)\b", re.I)),
    ("video", re.compile(r"\bvideos?\b", re.I)),
    ("post", re.compile(r"\bposts?\b", re.I)),
)


def content_type_mismatch(task: str, url: str) -> str:
    """"asked for a <x>, landed on a <y>", or "" when they agree or either is unclear.

    surface_mismatch below asks whether the COMPOSER contradicts the task. This asks the same thing
    one level up, about the page, because a page can hand you a perfectly good composer that belongs
    to the wrong thing entirely. Measured on instagram 2026-08-04: "write a comment on the first
    post" opened a STORY (`/stories/<user>/`), whose reply box is a real composer, so every gate
    downstream was satisfied and the comment would have gone to a story nobody asked about.

    Both sides must be unambiguous. A task that names no type, or a URL that declares none, returns
    "" and changes nothing, so the cost of being wrong here is a page we decline to fill fast and
    hand to the model instead.
    """
    if not task or not url:
        return ""
    want = [name for name, rx in P_TASK_CONTENT_TYPES if rx.search(task)]
    got = [name for name, rx in P_URL_CONTENT_TYPES if rx.search(url)]
    if len(want) != 1 or len(got) != 1 or want[0] == got[0]:
        return ""
    return f"asked for a {want[0]}, landed on a {got[0]}"


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


def opener_index_in_state(state_text: str, task: Optional[str] = None):
    """(index, name) of the single composer OPENER, or None.

    An exact name, or a verb+noun compose phrase anywhere in a longer label. The second half is
    what reaches the openers whose label is a whole sentence, and it keeps the exactness the first
    half was buying: an upsell ('Send InMail') has the wrong noun and a count ('526 comments') has
    no verb. Still a SINGLETON, so two candidates stay the model's problem, not a coin flip.

    Pass `task` to drop openers that contradict it, which is what keeps a comment task off the
    'New post' upload button. Optional so existing read-only callers are unaffected."""
    hits = [(int(m.group(1)), m.group(2)) for m in P_OPENER_ROW_RE.finditer(state_text or "")]
    if not hits:
        hits = [(int(m.group(1)), m.group(2))
                for m in P_CONTROL_ROW_RE.finditer(state_text or "")
                if P_OPENER_PHRASE_RE.search(m.group(2) or "")]
    if task is not None:
        hits = [h for h in hits if not opener_contradicts_task(task, h[1])]
    return hits[0] if len(hits) == 1 else None


# "New post", "Create", "Compose" open a BLANK thing. Fine when the task is to write something new;
# wrong when the task is to respond to something that already exists.
P_CREATE_OPENER_RE = re.compile(r"\b(new|create|compose|start a)\b", re.I)


def opener_contradicts_task(task: str, opener_name: str) -> bool:
    """True when this opener would take us somewhere the task did not ask to go.

    Measured on instagram 2026-08-04: a "write a comment on the first post" task matched the opener
    `New post Create`, which is the UPLOAD flow, so the run left the feed for a file picker and
    never saw a post. Nothing downstream could catch it, because by then the only evidence left was
    a page with no composer on it.

    Only the create-vs-respond direction, because that is the one with a wrong destination. A
    respond-shaped opener on a create task is left alone: some sites really do route a new post
    through a control labelled "Write".
    """
    t, name = task or "", opener_name or ""
    responding = bool(P_COMMENT_INTENT_RE.search(t))
    return responding and bool(P_CREATE_OPENER_RE.search(name))


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
