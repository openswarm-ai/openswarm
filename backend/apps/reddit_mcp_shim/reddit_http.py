"""Low-level authed Reddit transport.

Talks to Reddit as the user's own logged-in browser: borrow the session cookies and
call the classic www.reddit.com JSON API (reads take a .json suffix, writes carry the
account's modhash), no OAuth app and no API key. Modern Reddit ("shreddit") stopped
embedding a bearer token in its page HTML, so the cookie + modhash path is the durable
one. Rate-limited and self-healing on a 401/403 by re-borrowing the session. stdlib-only.
"""

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, Optional

from backend.apps.reddit_mcp_shim import rate_limit
from backend.apps.social_shims.session_source import get_session, invalidate

DOMAIN = "reddit.com"
WWW = "https://www.reddit.com"
MODHASH_TTL_S = 300.0

p_modhash = ""
p_modhash_exp = 0.0


class RedditError(Exception):
    """A Reddit request failed in a way worth surfacing to the agent."""


def modhash(force: bool = False) -> str:
    """Return the logged-in account's modhash (Reddit's per-session write token), cached briefly."""
    global p_modhash, p_modhash_exp
    now = time.time()
    if not force and p_modhash and now < p_modhash_exp:
        return p_modhash
    me = p_send("GET", "/api/me.json", params=None, form=None, action="read", retried=False)
    mh = (me or {}).get("data", {}).get("modhash") or ""
    if not mh:
        invalidate(DOMAIN)
        raise RedditError(
            "Not logged in to Reddit. Open reddit.com in the OpenSwarm browser, sign in, then retry."
        )
    p_modhash, p_modhash_exp = mh, now + MODHASH_TTL_S
    return mh


def api(method: str, path: str, *, params: Optional[Dict[str, Any]] = None,
        form: Optional[Dict[str, Any]] = None, action: str = "read") -> Any:
    """Authenticated www.reddit.com call: reads get a .json suffix, writes carry the modhash."""
    return p_send(method, path, params=params, form=form, action=action, retried=False)


def p_send(method: str, path: str, *, params: Optional[Dict[str, Any]],
           form: Optional[Dict[str, Any]], action: str, retried: bool) -> Any:
    rate_limit.acquire(action)
    cookie, ua = get_session(DOMAIN)
    headers = {"Cookie": cookie, "User-Agent": ua, "Accept": "application/json"}
    data = None
    if method == "GET":
        p = path if path.endswith(".json") else path + ".json"
        qs = dict(params or {})
        qs.setdefault("raw_json", 1)
        url = f"{WWW}{p}?" + urllib.parse.urlencode({k: v for k, v in qs.items() if v is not None})
    else:
        url = f"{WWW}{path}"
        if params:
            url += "?" + urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
        body = dict(form or {})
        body.setdefault("api_type", "json")
        body["uh"] = modhash()
        data = urllib.parse.urlencode({k: v for k, v in body.items() if v is not None}).encode()
        headers["Content-Type"] = "application/x-www-form-urlencoded"

    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30.0) as resp:
            status, raw, rhdr = resp.status, resp.read(), dict(resp.headers)
    except urllib.error.HTTPError as e:
        status, raw, rhdr = e.code, (e.read() if e.fp else b""), dict(e.headers or {})
    except urllib.error.URLError as e:
        raise RedditError(f"Reddit unreachable: {getattr(e, 'reason', e)}")

    rate_limit.note_response(status, {k.lower(): v for k, v in rhdr.items()})
    if status in (401, 403) and not retried:
        invalidate(DOMAIN)
        p_reset_modhash()
        return p_send(method, path, params=params, form=form, action=action, retried=True)
    if status == 429:
        raise RedditError("Reddit is rate-limiting this account; slow down and retry shortly.")
    if status >= 400:
        raise RedditError(f"Reddit HTTP {status}: {raw[:300].decode('utf-8', 'replace')}")
    try:
        return json.loads(raw.decode("utf-8", errors="replace") or "{}")
    except json.JSONDecodeError:
        return {"raw": raw.decode("utf-8", errors="replace")}


def p_reset_modhash() -> None:
    global p_modhash_exp
    p_modhash_exp = 0.0
