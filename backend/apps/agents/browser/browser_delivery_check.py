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
from typing import Awaitable, Callable
from urllib.parse import urlparse

from typeguard import typechecked

from backend.apps.agents.browser import browser_submit_click

ToolRunner = Callable[[str, dict, str, str], Awaitable[dict]]

# Hosts known to accept-then-silently-drop an automated post. A newly-found one is a one-line add.
GHOST_DROP_HOSTS = ("youtube.com",)


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
async def p_payload_visible(payload: str, browser_id: str, tab_id: str, execute_tool: ToolRunner) -> bool:
    try:
        r = await asyncio.wait_for(execute_tool(
            "BrowserEvaluate", {"expression": delivery_probe_expression(payload)},
            browser_id, tab_id), timeout=6.0)
    except Exception:
        return False
    v = browser_submit_click.parse_eval_value(r)
    return bool(isinstance(v, dict) and v.get("visible"))


@typechecked
async def ghost_delivery_confirmed(
    payload: str, browser_id: str, tab_id: str, execute_tool: ToolRunner
) -> bool:
    """For a ghost-drop host: did the post render AND survive the server-side drop window? True
    only if the payload is visible now and STILL visible a few seconds later. A post that never
    rendered, or rendered then vanished, returns False, so we never claim a delivery the site ate.
    Pure page reads (no navigation), invisible to the site."""
    if not await p_payload_visible(payload, browser_id, tab_id, execute_tool):
        return False
    await asyncio.sleep(3.5)
    return await p_payload_visible(payload, browser_id, tab_id, execute_tool)


@typechecked
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
