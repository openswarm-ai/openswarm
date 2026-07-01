"""Low-level authed X (Twitter) transport.

Borrow the user's x.com session (auth_token + ct0 cookies), attach the public web
bearer + the ct0-derived CSRF header, and call x.com's own /i/api GraphQL + v1.1/v2
surfaces exactly as the logged-in web client does. Rate-limited and self-refreshing
on a 401/403 by re-borrowing the session. stdlib-only to match the sibling shims.
"""

import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, Optional

from backend.apps.social_shims.session_source import cookie_value, get_session, invalidate
from backend.apps.x_mcp_shim import rate_limit
from backend.apps.x_mcp_shim.x_endpoints import DEFAULT_FEATURES, GRAPHQL_IDS, WEB_BEARER

DOMAIN = "x.com"
API = "https://x.com/i/api"
GRAPHQL = f"{API}/graphql"


class XError(Exception):
    """An X request failed in a way worth surfacing to the agent."""


def p_send(method: str, url: str, *, data: Optional[bytes], content_type: Optional[str],
           action: str, retried: bool = False) -> Any:
    rate_limit.acquire(action)
    cookie, ua = get_session(DOMAIN)
    ct0 = cookie_value(DOMAIN, "ct0")
    if not ct0:
        invalidate(DOMAIN)
        raise XError("No x.com CSRF cookie (ct0). Open x.com in the OpenSwarm browser, sign in, then retry.")
    headers = {
        "Authorization": f"Bearer {WEB_BEARER}",
        "Cookie": cookie,
        "User-Agent": ua,
        "x-csrf-token": ct0,
        "x-twitter-auth-type": "OAuth2Session",
        "x-twitter-active-user": "yes",
        "x-twitter-client-language": "en",
        "Accept": "application/json",
        "Referer": "https://x.com/",
    }
    if data is not None and content_type:
        headers["Content-Type"] = content_type
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30.0) as resp:
            status, raw, rhdr = resp.status, resp.read(), dict(resp.headers)
    except urllib.error.HTTPError as e:
        status, raw, rhdr = e.code, (e.read() if e.fp else b""), dict(e.headers or {})
    except urllib.error.URLError as e:
        raise XError(f"x.com unreachable: {getattr(e, 'reason', e)}")

    rate_limit.note_response(status, {k.lower(): v for k, v in rhdr.items()})
    if status in (401, 403) and not retried:
        invalidate(DOMAIN)
        return p_send(method, url, data=data, content_type=content_type, action=action, retried=True)
    if status == 429:
        raise XError("x.com is rate-limiting this account; slow down and retry shortly.")
    if status >= 400:
        raise XError(f"x.com HTTP {status}: {raw[:300].decode('utf-8', 'replace')}")
    try:
        return json.loads(raw.decode("utf-8", errors="replace") or "{}")
    except json.JSONDecodeError:
        return {"raw": raw.decode("utf-8", errors="replace")}


def graphql(op: str, variables: Dict[str, Any], *, method: str = "GET",
            features: bool = True, action: str = "read") -> Any:
    """Call a GraphQL operation by name, looking up its (drift-prone) queryId."""
    qid = GRAPHQL_IDS.get(op)
    if not qid:
        raise XError(f"Unknown GraphQL op {op!r}; add its queryId to x_endpoints.GRAPHQL_IDS.")
    url = f"{GRAPHQL}/{qid}/{op}"
    if method == "GET":
        params = {"variables": json.dumps(variables, separators=(",", ":"))}
        if features:
            params["features"] = json.dumps(DEFAULT_FEATURES, separators=(",", ":"))
        return p_send("GET", url + "?" + urllib.parse.urlencode(params),
                      data=None, content_type=None, action=action)
    body: Dict[str, Any] = {"variables": variables, "queryId": qid}
    if features:
        body["features"] = DEFAULT_FEATURES
    return p_send("POST", url, data=json.dumps(body).encode(), content_type="application/json", action=action)


def rest(method: str, path: str, *, params: Optional[Dict[str, Any]] = None,
         form: Optional[Dict[str, Any]] = None, json_body: Optional[Dict[str, Any]] = None,
         action: str = "read") -> Any:
    """Call a legacy v1.1/v2 endpoint (more stable than GraphQL for follow/DM). path includes the version."""
    url = f"{API}/{path}"
    if params:
        url += "?" + urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
    if json_body is not None:
        return p_send(method, url, data=json.dumps(json_body).encode(),
                      content_type="application/json", action=action)
    if form is not None:
        data = urllib.parse.urlencode({k: v for k, v in form.items() if v is not None}).encode()
        return p_send(method, url, data=data, content_type="application/x-www-form-urlencoded", action=action)
    return p_send(method, url, data=None, content_type=None, action=action)
