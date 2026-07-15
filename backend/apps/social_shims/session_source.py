"""Borrow the user's live browser session (cookies + UA) for a domain.

Shared by every social MCP shim (reddit/x/tiktok). The shim never stores
credentials. It asks the backend's browser-session bridge (gated by the same
per-install token every OpenSwarm shim uses) for the cookies the user's own
logged-in browser already holds in the persist:openswarm-browser partition, then
talks to the site as that browser. stdlib-only so the subprocess starts fast.
"""

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Dict, Tuple

BACKEND_PORT = os.environ.get("OPENSWARM_PORT", "8324")
AUTH_TOKEN = os.environ.get("OPENSWARM_AUTH_TOKEN", "")
BRIDGE_URL = f"http://127.0.0.1:{BACKEND_PORT}/api/browser-session/cookies"
CACHE_TTL_S = 60.0

# Fallback only; the bridge returns the real spoofed Chrome UA the webview uses.
DEFAULT_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)

p_cache: Dict[str, Tuple[float, str, str]] = {}


class SessionUnavailable(Exception):
    """No live logged-in session could be borrowed for the domain."""


def get_session(domain: str) -> Tuple[str, str]:
    """Return (cookie_header, user_agent) for domain from the live browser session.

    Raises SessionUnavailable with a human-actionable message when the bridge is
    unreachable or the user isn't logged in (no cookies for the domain).
    """
    now = time.time()
    hit = p_cache.get(domain)
    if hit and now - hit[0] < CACHE_TTL_S:
        return hit[1], hit[2]

    url = BRIDGE_URL + "?" + urllib.parse.urlencode({"domain": domain})
    headers = {"Accept": "application/json"}
    if AUTH_TOKEN:
        headers["Authorization"] = f"Bearer {AUTH_TOKEN}"
    req = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=20.0) as resp:
            data = json.loads(resp.read().decode("utf-8", errors="replace") or "{}")
    except urllib.error.HTTPError as e:
        raise SessionUnavailable(f"Session bridge error (HTTP {e.code}); is the OpenSwarm dashboard open?")
    except urllib.error.URLError as e:
        raise SessionUnavailable(f"Session bridge unreachable: {getattr(e, 'reason', e)}")
    except Exception as e:
        raise SessionUnavailable(f"Session bridge request failed: {e!r}")

    if data.get("error"):
        raise SessionUnavailable(str(data["error"]))
    cookies = data.get("cookies") or []
    if not cookies:
        raise SessionUnavailable(
            f"Not logged in to {domain}. Open {domain} in the OpenSwarm browser, sign in, then retry."
        )
    cookie_header = "; ".join(
        f"{c['name']}={c['value']}" for c in cookies if c.get("name")
    )
    user_agent = data.get("userAgent") or DEFAULT_UA
    p_cache[domain] = (now, cookie_header, user_agent)
    return cookie_header, user_agent


def cookie_value(domain: str, name: str) -> str:
    """Pull a single cookie's value from the borrowed session (e.g. x's ct0 CSRF token)."""
    cookie_header, _ = get_session(domain)
    for pair in cookie_header.split(";"):
        k, _, v = pair.strip().partition("=")
        if k == name:
            return v
    return ""


def invalidate(domain: str) -> None:
    """Drop the cached session so the next call re-borrows fresh cookies."""
    p_cache.pop(domain, None)
