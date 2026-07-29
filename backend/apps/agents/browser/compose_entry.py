"""The site's own URL for opening a composer, used when the task is to create something new.

Reachability, not fill mechanics, is what a 20-run dry sweep measured as the ceiling on scripted
writes: the send script armed 20/20 and reached a composer 0/20. The fill, the commit check and the
two-sided receipt are all proven; what fails is that prestage's aux navigator lands on the site's
HOME page, and the composer is one more hop that it does not reliably take. Polling harder does not
help, it was tried twice and the reached rate went 40% -> 0%.

Every site here publishes a URL that opens its own composer. Asking for that URL is deterministic
where hunting for a button is not: no selector to drift, no modal to race, no capped element list to
starve. It is also cheaper, since a hit skips the aux navigation loop entirely.

Deliberately narrow, because composing in the wrong place is worse than not composing at all:

  - only for a task that creates something TOP-LEVEL. A reply or comment belongs on the thread the
    user is looking at, so those keep their own target (the same rule the post-is-not-a-comment
    guard enforces on the composer, applied one layer earlier and one layer cheaper).
  - only when the task points at the bare site. Any deeper URL on that host is a specific target
    the user chose, and it outranks the generic composer every time.
  - only as a PROPOSAL. The caller navigates, then checks whether a composer actually appeared; if
    it did not, the normal path runs untouched. A site that changes its compose URL degrades to
    today's behaviour rather than stranding the run somewhere useless.
"""

import os
import re
from typing import Dict, Optional
from urllib.parse import urlparse

from typeguard import typechecked

from backend.apps.agents.browser import browser_fast_path, browser_send_parse

# Registrable host -> the site's own compose URL. A dynamic-key map keyed by host, matched by
# suffix so www./m./mobile. variants all resolve. Adding a site is one row.
#
# These are the sites' own documented entry points, not scraped links:
#   x            /compose/post          opens the post dialog on a fresh page
#   linkedin     ?shareActive=true      opens the "start a post" modal on the feed
#   reddit       /submit?type=TEXT      the self-post form
#   gmail        ?compose=new           opens a compose window in the mail UI
P_COMPOSE_URLS: Dict[str, str] = {
    "x.com": "https://x.com/compose/post",
    "twitter.com": "https://x.com/compose/post",
    "linkedin.com": "https://www.linkedin.com/feed/?shareActive=true",
    "reddit.com": "https://www.reddit.com/submit?type=TEXT",
    "mail.google.com": "https://mail.google.com/mail/u/0/#inbox?compose=new",
}

# Creating something new. "compose"/"draft"/"email" carry gmail, where nobody says "post".
P_CREATE_RE = re.compile(
    r"\b(post|posting|tweet|tweeting|publish|share|compose|draft|write|send)\b", re.I)
# Answering something that already exists. One of these and the target is the thread, not the site.
P_RESPOND_RE = re.compile(r"\b(reply|replies|replying|comment|commenting|respond|responding|"
                          r"answer|answering|quote|retweet|dm|message)\b", re.I)
P_URL_RE = re.compile(r"https?://[^\s\"'<>)\]]+", re.I)
# "go to x.com and post ..." names its site without a scheme, which is how most tasks arrive.
P_BARE_HOST_RE = re.compile(r"(?:^|[\s/@(,])((?:[\w-]+\.)+[a-z]{2,})\b", re.I)


@typechecked
def registrable_host(url_or_host: str) -> str:
    """The host with any www./m./mobile. prefix removed, lowercased, port dropped.

    Prefix stripping is done with a real prefix check; `lstrip("www.")` would eat any leading w
    or dot and quietly turn `w3schools.com` into `3schools.com`."""
    raw = (url_or_host or "").strip()
    host = urlparse(raw).netloc if "//" in raw else raw
    host = host.lower().split("@")[-1].split(":")[0]
    for prefix in ("www.", "m.", "mobile."):
        if host.startswith(prefix):
            host = host[len(prefix):]
            break
    return host


@typechecked
def p_table_hit(host: str) -> str:
    """The compose URL for this host, matching a parent domain too (`old.reddit.com` -> reddit).

    Exact-or-dotted-suffix only: a bare `endswith` would match `notreddit.com` against `reddit.com`
    and send a post to a site the user never named."""
    host = registrable_host(host)
    if not host:
        return ""
    if host in P_COMPOSE_URLS:
        return P_COMPOSE_URLS[host]
    for known, url in P_COMPOSE_URLS.items():
        if host.endswith("." + known):
            return url
    return ""


@typechecked
def p_names_deeper_target(task: str, host: str) -> bool:
    """True when the task carries a URL on this host that points somewhere more specific than its
    front page. That URL is the user's chosen target and must win over the generic composer."""
    want = registrable_host(host)
    for m in P_URL_RE.finditer(human_words(task)):
        parsed = urlparse(m.group(0).rstrip(".,;)"))
        found = registrable_host(parsed.netloc)
        if not found or (found != want and not found.endswith("." + want)):
            continue
        if parsed.path.strip("/") or parsed.query or parsed.fragment:
            return True
    return False


@typechecked
def human_words(task: str) -> str:
    """The task minus the aux-written routing brief.

    A dispatched task is the user's prompt followed by a brief a model wrote about how to route it.
    The brief is prose, and it both quotes things of its own and uses answering words, so reading
    intent off the whole string reads the model's commentary as the user's request. The send script
    hit this first (a brief saying "do not submit it" read-only-flagged a real send).

    Everything reads this, refusals included. Letting the brief veto looked like the safe choice
    and was not: briefs routinely spell out a route ("navigate to https://x.com/home"), so the
    deeper-target veto fired on the model's own suggestion and silently disabled the tier on two of
    four sites. A brief cannot turn a post into a reply either, since the words that would say so
    are the user's and are still read here."""
    return (task or "").split(browser_fast_path.BRIEF_MARKER, 1)[0]


@typechecked
def wants_top_level_compose(task: str) -> bool:
    """True when the task creates something new rather than answering something that exists.

    An intent word alone is not enough: "what is the top post on reddit" is a READ, and `post` there
    is a noun. Reading the verb correctly needs a model, so instead this asks for the thing every
    real write in this product carries and no read does, the quoted text to write. That is also the
    send script's own precondition, so a task this refuses is one the script would decline anyway,
    and the aux navigator handles it exactly as it does today."""
    text = human_words(task)
    if not browser_send_parse.quoted_payload(text):
        return False
    return bool(P_CREATE_RE.search(text)) and not P_RESPOND_RE.search(text)


@typechecked
def enabled() -> bool:
    """On by default. This tier only ever navigates the user's browser to a page that site
    publishes for exactly this purpose, and the caller verifies the result before relying on it, so
    the failure mode is a wasted page load rather than a wrong action. The switch exists to A/B it
    against the aux navigator and to turn it off in the field without a rebuild."""
    return os.environ.get("OSW_COMPOSE_ENTRY", "1") != "0"


@typechecked
def compose_entry_for(task: str, start_url: str, task_is_send: bool) -> Optional[str]:
    """The URL to open to reach this site's composer, or None to leave navigation alone.

    `start_url` is where the card already is; a host named in the task counts too, since a run that
    begins on a blank tab still says "go to x.com and post ...".

    `task_is_send` is the caller's already-computed write verdict and is REQUIRED, not defaulted,
    because forgetting it is silently destructive: a quote is not proof of a write, and
    `find the reddit post that says "..."` reads as a create to any regex short enough to be
    readable (`post` is a noun there). Four such phrasings each resolved to reddit's SUBMIT page in
    a probe, which would derail a plain read. The verdict the send script itself gates on is the
    right authority, so this asks for it rather than growing a second opinion that can drift."""
    if not enabled() or not task_is_send or not wants_top_level_compose(task):
        return None
    # Which site to open comes from the user's words; a brief naming some other site must not
    # redirect the post.
    asked = human_words(task)
    named = [m.group(0) for m in P_URL_RE.finditer(asked)]
    named += [m.group(1) for m in P_BARE_HOST_RE.finditer(asked)]
    for candidate in (start_url, *named):
        url = p_table_hit(candidate)
        if not url:
            continue
        host = registrable_host(candidate)
        if p_names_deeper_target(task, host):
            return None
        # Already on the compose surface: navigating again would remount it and throw away a
        # composer that is right there.
        if registrable_host(start_url) == host and p_on_compose_surface(start_url, url):
            return None
        return url
    return None


@typechecked
def p_on_compose_surface(current_url: str, compose_url: str) -> bool:
    """True when the current URL is already this site's compose surface."""
    cur, target = urlparse(current_url or ""), urlparse(compose_url or "")
    if not cur.netloc:
        return False
    cur_mark = (cur.path.strip("/") + "?" + cur.query + "#" + cur.fragment).lower()
    target_mark = (target.path.strip("/") + "?" + target.query + "#" + target.fragment).lower()
    for token in ("compose", "submit", "shareactive"):
        if token in target_mark and token in cur_mark:
            return True
    return False
