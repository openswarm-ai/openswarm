"""Delivery ground-truth for a write: did the post ACTUALLY land, or did the site clear the
composer and silently eat it?

A cleared composer proves delivery everywhere EXCEPT the ghost-drop hosts (YouTube-class), which
accept an automated post, clear the box, maybe render it for a beat, then drop it server-side. On
those we re-read the live page to confirm the post PERSISTS before anyone claims success;
everywhere else the cleared composer stays the trusted proxy (proven across X/Reddit/LinkedIn/
Gmail) and this module is never consulted, so proven sends keep their exact speed.
"""

import asyncio
import json
import re
from typing import Awaitable, Callable, Optional
from urllib.parse import urlparse

from typeguard import typechecked

from backend.apps.agents.browser import browser_submit_click

ToolRunner = Callable[[str, dict, str, str], Awaitable[dict]]

# Hosts known to accept-then-silently-drop an automated post. A newly-found one is a one-line add.
# reddit joined 2026-07-31 on live evidence, twice: the r/test submit form clears the composer and
# the post never appears in r/test/new (markers canary5ef128b9 and canary99b063a2, both audited
# absent). Without this the cleared composer is trusted as delivery and the user gets told
# 'Done, I sent "canary..." for you' about a post that does not exist.
GHOST_DROP_HOSTS = ("youtube.com", "reddit.com")

# What a site says when it REFUSED the write. Only ever consulted inside a live announcement
# region, never against the whole page, so an unrelated "failed" in an article body can't match.
P_REJECTION_RE = re.compile(
    r"something went wrong|went wrong|couldn'?t\s|could not\s|unable to|failed to|"
    r"\bfailed\b|try again|too many|rate.?limit|limit exceeded|not allowed|"
    r"blocked|error occurred|wasn'?t (?:sent|posted)|was not (?:sent|posted)",
    re.I,
)


@typechecked
def is_ghost_drop_host(url: str) -> bool:
    host = (urlparse(url or "").hostname or "").lower().lstrip(".")
    return any(host == g or host.endswith("." + g) for g in GHOST_DROP_HOSTS)


@typechecked
def delivery_probe_expression(payload: str) -> str:
    """JS reporting whether a distinctive chunk of `payload` is rendered in the page's VISIBLE
    text. Run only AFTER the composer cleared, so a hit means the text lives in real page content
    (the posted item / a confirmation), not the emptied composer."""
    needle = " ".join((payload or "").split())[:80]
    return ("(()=>{try{var n=" + json.dumps(needle) + ";"
            "var t=(document.body&&document.body.innerText)||'';"
            "return {visible: n.length>0 && t.indexOf(n)!==-1};}"
            "catch(e){return {visible:false};}})()")


@typechecked
async def payload_visible(
    payload: str, browser_id: str, tab_id: str, execute_tool: ToolRunner
) -> Optional[bool]:
    """True = seen on the page, False = looked and it is NOT there, None = could not look.

    The third case is not pedantry. Returning False for a probe that timed out or came back
    unreadable is asserting absence from a failed observation, and that is the same mistake as a
    receipt claiming delivery it never saw, pointed the other way: it tells the user a post did not
    land when nobody actually checked. Measured tonight, the identical shape in the test harness
    scored every unreadable verification as a successful delete and left six posts on a real
    account while reporting them cleaned.
    """
    try:
        r = await asyncio.wait_for(execute_tool(
            "BrowserEvaluate", {"expression": delivery_probe_expression(payload)},
            browser_id, tab_id), timeout=6.0)
    except Exception:
        return None
    v = browser_submit_click.parse_eval_value(r)
    if not isinstance(v, dict) or "visible" not in v:
        return None
    return bool(v.get("visible"))


@typechecked
def rejection_probe_expression() -> str:
    """JS returning the text of the page's live ANNOUNCEMENT regions only.

    role="alert" and aria-live are how sites are required to announce a transient result to
    assistive tech, so error toasts land here on every major site without us naming any of them.
    Scoped deliberately: reading whole-page text for the word "failed" would match articles,
    changelogs and half the internet."""
    return ("(()=>{try{var out=[];"
            "var sel='[role=alert],[role=alertdialog],[aria-live=assertive],[aria-live=polite]';"
            "document.querySelectorAll(sel).forEach(function(e){"
            "var s=(e.innerText||'').trim(); if(s) out.push(s);});"
            "return {text: out.join(' | ').slice(0,600)};}"
            "catch(e){return {text:''};}})()")


@typechecked
async def send_rejected(browser_id: str, tab_id: str, execute_tool: ToolRunner) -> bool:
    """Did the site announce that the write FAILED, right after the composer cleared?

    A cleared composer is the receipt this whole fast path rests on, and the code has long admitted
    it "cannot tell submitted from dismissed". The realistic way that bites is not a mis-click: it
    is the site accepting the click, clearing the box, and popping "Something went wrong" or a rate
    limit. The receipt then reads as success and the agent tells the user it posted.

    This only ever DEMOTES a claim, and only on an explicit failure announcement, so a normal send
    (no alert region, or a success toast) is untouched and keeps its measured speed. Any read
    failure returns False, because refusing to claim delivery on the basis of a broken probe would
    invent failures that did not happen."""
    try:
        r = await asyncio.wait_for(execute_tool(
            "BrowserEvaluate", {"expression": rejection_probe_expression()},
            browser_id, tab_id), timeout=4.0)
    except Exception:
        return False
    v = browser_submit_click.parse_eval_value(r)
    if not isinstance(v, dict):
        return False
    return bool(P_REJECTION_RE.search(str(v.get("text") or "")))


@typechecked
def rejected_send_note(url: str, payload: str) -> str:
    """Honest line for a send the SITE said no to. Distinct from the unverified case: here we are
    not guessing, the page told us, so the user should be told plainly rather than asked to check."""
    host = urlparse(url or "").hostname or "the site"
    if host.startswith("www."):
        host = host[4:]
    clip = payload if len(payload) <= 80 else payload[:77] + "..."
    return (f'I typed "{clip}" and clicked send, but {host} rejected it: the composer cleared and '
            f'the page showed an error instead of posting. It did NOT go through. I did not retry, '
            f'since whatever the site refused is likely to be refused again.')


@typechecked
async def ghost_delivery_confirmed(
    payload: str, browser_id: str, tab_id: str, execute_tool: ToolRunner
) -> bool:
    """For a ghost-drop host: did the post render AND survive the server-side drop window? True
    only if the payload is visible now and STILL visible a few seconds later. A post that never
    rendered, or rendered then vanished, returns False, so we never claim a delivery the site ate.
    Pure page reads (no navigation), invisible to the site."""
    # `is not True` deliberately: an unknown must NOT confirm. This is the one place where
    # collapsing unknown into "no" is right, because the caller is deciding whether to CLAIM a
    # delivery, and withholding an uncertain claim is the safe direction.
    if await payload_visible(payload, browser_id, tab_id, execute_tool) is not True:
        return False
    await asyncio.sleep(3.5)
    return await payload_visible(payload, browser_id, tab_id, execute_tool) is True


@typechecked
def unverified_send_note(url: str, payload: str) -> str:
    """Honest line for a send whose click RAN but whose two-sided receipt never arrived.

    Deliberately weaker than unconfirmed_delivery_note: there the composer cleared and the post
    later vanished, so we know it was submitted. Here we never got the clear at all, so we know
    strictly less and must claim strictly less. Measured 2026-07-28 on X: the agent reported "your
    message went through and it's showing in the conversation now" on exactly this evidence and
    nothing had been posted. Overclaiming here is the worst failure this agent has, because the
    user stops checking.
    """
    host = urlparse(url or "").hostname or "the site"
    if host.startswith("www."):
        host = host[4:]
    clip = payload if len(payload) <= 80 else payload[:77] + "..."
    return (f'I typed "{clip}" and clicked send on {host}, but I could NOT confirm it actually '
            f'posted: the composer never cleared, which is the signal I rely on. It may or may not '
            f'have gone through, so please check before relying on it. I did not try again, because '
            f'a blind retry is how you end up posting twice.')


def unconfirmed_delivery_note(url: str, payload: str) -> str:
    """Plain honest fallback line when a ghost-drop send can't be confirmed (the aux-composed
    version in browser_agent is preferred; this is the never-fails template behind it)."""
    host = urlparse(url or "").hostname or "the site"
    if host.startswith("www."):
        host = host[4:]
    clip = payload if len(payload) <= 80 else payload[:77] + "..."
    return (f'I submitted "{clip}" and the composer cleared, but I could NOT confirm it stayed '
            f'live: {host} sometimes accepts an automated post and then drops it without an error. '
            f'Please check your posts to verify it actually went through before relying on it.')
