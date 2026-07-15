"""Low-level authed TikTok transport.

Borrow the user's tiktok.com session, attach device params + msToken, and call the
web /api surface. Detects TikTok's anti-bot / verify rejections (the signature gate)
and raises an actionable error pointing at the browser fallback. stdlib-only.
"""

import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, Optional

from backend.apps.social_shims.session_source import get_session, invalidate
from backend.apps.tiktok_mcp_shim import rate_limit
from backend.apps.tiktok_mcp_shim.tiktok_endpoints import API, DOMAIN
from backend.apps.tiktok_mcp_shim.tiktok_sign import signed_query

SIGNATURE_HINT = (
    "TikTok blocked this as unsigned/automated (its X-Bogus/X-Gnarly gate). Reads sometimes "
    "slip through; signed writes and uploads need a real browser. Use the OpenSwarm browser "
    "agent for TikTok actions: it drives your live tiktok.com session, so it's free, "
    "undetectable, and can do everything a human can."
)


class TikTokError(Exception):
    """A TikTok request failed in a way worth surfacing to the agent."""


def check_antibot(body: Any) -> None:
    if not isinstance(body, dict):
        return
    sc = body.get("statusCode", body.get("status_code"))
    if sc not in (0, None):
        msg = body.get("statusMsg") or body.get("status_msg") or ""
        raise TikTokError(f"TikTok statusCode {sc} {msg}. {SIGNATURE_HINT}".strip())


def p_request(method: str, path: str, *, params: Optional[Dict[str, Any]],
              form: Optional[Dict[str, Any]], action: str, retried: bool) -> Any:
    rate_limit.acquire(action)
    cookie, ua = get_session(DOMAIN)
    url = f"{API}/{path}?" + signed_query(params or {})
    data = None
    if form is not None:
        data = urllib.parse.urlencode({k: v for k, v in form.items() if v is not None}).encode()
    headers = {
        "Cookie": cookie,
        "User-Agent": ua,
        "Accept": "application/json, text/plain, */*",
        "Referer": "https://www.tiktok.com/",
    }
    if data is not None:
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30.0) as resp:
            status, raw, rhdr = resp.status, resp.read(), dict(resp.headers)
    except urllib.error.HTTPError as e:
        status, raw, rhdr = e.code, (e.read() if e.fp else b""), dict(e.headers or {})
    except urllib.error.URLError as e:
        raise TikTokError(f"tiktok.com unreachable: {getattr(e, 'reason', e)}")

    rate_limit.note_response(status, {k.lower(): v for k, v in rhdr.items()})
    if status in (401, 403) and not retried:
        invalidate(DOMAIN)
        return p_request(method, path, params=params, form=form, action=action, retried=True)
    if status == 429:
        raise TikTokError("tiktok.com is rate-limiting this account; slow down and retry shortly.")
    if status >= 400:
        raise TikTokError(f"tiktok.com HTTP {status}: {raw[:200].decode('utf-8', 'replace')}. {SIGNATURE_HINT}")
    text = raw.decode("utf-8", errors="replace").strip()
    if not text:
        raise TikTokError(f"TikTok returned an empty response. {SIGNATURE_HINT}")
    try:
        body = json.loads(text)
    except json.JSONDecodeError:
        raise TikTokError(f"TikTok returned a non-JSON page (likely a verify/captcha wall). {SIGNATURE_HINT}")
    check_antibot(body)
    return body


def get(path: str, params: Dict[str, Any], *, action: str = "read") -> Any:
    return p_request("GET", path, params=params, form=None, action=action, retried=False)


def post(path: str, params: Dict[str, Any], form: Dict[str, Any], *, action: str) -> Any:
    return p_request("POST", path, params=params, form=form, action=action, retried=False)
