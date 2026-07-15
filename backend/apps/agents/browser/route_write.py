"""General capture-and-replay write tier: replay a write the site's OWN UI issues, via the
borrowed session, WITHOUT a hand-written per-site adapter. This is the site-agnostic path to
write coverage (the "all popular sites" lever): the browser passively captures the internal API
routes the page fires (electron/cdp-routes.js), and this replays a MUTATING one with the agent's
content substituted, using live-borrowed cookies (never persisted) plus any CSRF header the site
derives from a cookie.

SAFETY (this IS the posture flip away from GET/HEAD-only, so the walls are belt-and-suspenders):
- Same-origin: the target must be the site currently loaded, nothing else.
- Captured-route match: the target must correspond to a mutating route the site's OWN UI actually
  fired. The agent can't invent an endpoint; it can only replay one the page genuinely uses. This
  is the wall against a prompt-injected page steering the agent to an arbitrary write.
- Flag-gated default OFF (OSW_ROUTE_WRITE=1 to arm). The deterministic per-site adapters (Reddit)
  stay always-on; this general tier is opt-in until it's soaked.
- Behind the caller's send-safety guard (solo, verified, receipt-or-honest-miss, never a false
  claim of success).
- Secret-safe: cookies are live-borrowed per call, never logged, never persisted; the CSRF header
  is derived from a cookie at call time, not stored.
"""

import json
import os
import re
import time
import urllib.error
import urllib.request
from typing import Any, Dict, List
from urllib.parse import urlparse

from pydantic import BaseModel, ConfigDict
from typeguard import typechecked

from backend.apps.social_shims.session_source import get_session

WRITE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})
# CSRF header a site derives from a cookie (so it survives a fresh borrowed session). Small on
# purpose: most cookie-auth internal APIs need nothing extra; this covers the common header case.
P_CSRF_FROM_COOKIE: Dict[str, Dict[str, str]] = {
    "x.com": {"header": "x-csrf-token", "cookie": "ct0"},
    "twitter.com": {"header": "x-csrf-token", "cookie": "ct0"},
}


class CapturedRoute(BaseModel):
    """One mutating route the site's own UI was seen to fire (from the CDP route capture). The
    method + templated path are the identity we match a replay target against; nothing secret
    lives here (the capture redacts auth headers and strips body values)."""

    model_config = ConfigDict(validate_assignment=True)

    method: str
    template: str


class ReplayOutcome(BaseModel):
    """Typed result of a route replay. `receipt` is the site's own confirmation pulled from the
    response (an id / permalink / url); `ok` is False with a legible `error` on any refusal or
    rejection, so the caller falls back to the UI, never a crash and never a false success."""

    model_config = ConfigDict(validate_assignment=True)

    ok: bool
    receipt: str = ""
    error: str = ""
    status: int = 0
    latency_ms: int = 0


@typechecked
def enabled() -> bool:
    """The general route-write tier is opt-in (posture flip); armed only by OSW_ROUTE_WRITE=1."""
    return os.environ.get("OSW_ROUTE_WRITE", "0") == "1"


@typechecked
def p_template_path(url: str) -> str:
    """Collapse volatile path segments (numeric ids, long hex/uuids) to '{id}', mirroring the
    capture side (cdp-routes.js templateUrl) so a concrete replay URL matches the captured
    template. Origin + path only; query keys are ignored for the match."""
    try:
        u = urlparse(url)
        path = re.sub(r"/(\d+|[0-9a-fA-F]{8,}(?:-[0-9a-fA-F]+)*)(?=/|$)", "/{id}", u.path)
        return f"{u.scheme}://{u.netloc}{path}"
    except Exception:
        return url


@typechecked
def same_origin(url: str, origin: str) -> bool:
    """True when url is on the same origin as the loaded page (scheme+host+port), the first wall."""
    try:
        a, b = urlparse(url), urlparse(origin)
        return bool(a.scheme and a.netloc) and (a.scheme, a.netloc) == (b.scheme, b.netloc)
    except Exception:
        return False


@typechecked
def route_is_captured(method: str, url: str, captured: List[CapturedRoute]) -> bool:
    """True when (method, templated url) matches a mutating route the site's UI actually fired.
    The safety wall that stops a prompt-injected page from steering the agent to an invented
    endpoint: the agent can only replay a write the page genuinely uses."""
    m = method.upper()
    if m not in WRITE_METHODS:
        return False
    target = p_template_path(url)
    return any(r.method.upper() == m and p_template_path(r.template) == target for r in captured)


@typechecked
def p_cookie_value(cookie_header: str, name: str) -> str:
    """Pull one cookie's value out of a 'k=v; k2=v2' header, for CSRF-from-cookie derivation."""
    for part in (cookie_header or "").split(";"):
        k, _, v = part.strip().partition("=")
        if k == name:
            return v
    return ""


@typechecked
def derive_csrf_headers(url: str, cookie_header: str) -> Dict[str, str]:
    """The CSRF header a site expects, re-derived from the live cookie (e.g. X's x-csrf-token is
    its ct0 cookie). Empty for the common cookie-only-auth site, which needs nothing extra."""
    host = (urlparse(url).netloc or "").lower().lstrip(".")
    apex = ".".join(host.split(".")[-2:]) if host.count(".") >= 1 else host
    rule = P_CSRF_FROM_COOKIE.get(apex)
    if not rule:
        return {}
    val = p_cookie_value(cookie_header, rule["cookie"])
    return {rule["header"]: val} if val else {}


@typechecked
def receipt_from_json(obj: Any) -> str:
    """The most proof-bearing id/permalink/url anywhere in a response JSON (shallow-first), so the
    caller gets a real receipt without knowing each site's response shape."""
    seen: List[Any] = [obj]
    for _ in range(400):  # bounded walk; a receipt lives near the top of a write response
        if not seen:
            break
        cur = seen.pop(0)
        if isinstance(cur, dict):
            for key in ("permalink", "url", "id_str", "rest_id", "id", "name"):
                v = cur.get(key)
                if isinstance(v, (str, int)) and str(v):
                    return str(v)
            seen.extend(cur.values())
        elif isinstance(cur, list):
            seen.extend(cur)
    return ""


@typechecked
def outcome_from_response(status: int, text: str, latency_ms: int) -> ReplayOutcome:
    """Map an HTTP response to a typed outcome: 2xx = landed (with a parsed receipt), anything else
    = a legible error the caller surfaces so the model does the write via the UI instead."""
    if not (200 <= status < 300):
        return ReplayOutcome(ok=False, status=status, latency_ms=latency_ms,
                             error=f"site returned HTTP {status}: {text[:160]}")
    receipt = ""
    try:
        receipt = receipt_from_json(json.loads(text)) if text.strip() else ""
    except (json.JSONDecodeError, ValueError):
        receipt = ""
    return ReplayOutcome(ok=True, status=status, latency_ms=latency_ms, receipt=receipt or "ok")


@typechecked
def issue_request(method: str, url: str, body: Dict[str, Any], headers: Dict[str, str]) -> Any:
    """Issue the write from the backend using the borrowed session. JSON body (the shape internal
    APIs overwhelmingly use). Returns (status, text). Isolated so tests stub the network."""
    data = json.dumps(body).encode() if body else b""
    req = urllib.request.Request(url, data=data, headers=headers, method=method.upper())
    try:
        with urllib.request.urlopen(req, timeout=30.0) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, (e.read().decode("utf-8", "replace") if e.fp else "")
    except urllib.error.URLError as e:
        raise RuntimeError(f"site unreachable: {getattr(e, 'reason', e)}")


@typechecked
def replay_write(method: str, url: str, body: Dict[str, Any], origin: str,
                 captured: List[CapturedRoute]) -> ReplayOutcome:
    """Replay one captured mutating route with the agent's content, via the live-borrowed session.
    Every failure (disarmed, off-origin, un-captured, no session, site-reject) is a typed ok=False
    so the caller falls back to the UI, never a crash. Secrets are live-borrowed, never logged."""
    if not enabled():
        return ReplayOutcome(ok=False, error="route-write tier disarmed (set OSW_ROUTE_WRITE=1); use the UI")
    if not same_origin(url, origin):
        return ReplayOutcome(ok=False, error="target is not the current site (same-origin only)")
    if not route_is_captured(method, url, captured):
        return ReplayOutcome(ok=False, error="no matching write route was captured from this site's UI; use the UI")
    domain = (urlparse(origin).netloc or "").lstrip(".")
    t0 = time.monotonic()
    try:
        cookie, ua = get_session(domain)
    except Exception as e:
        return ReplayOutcome(ok=False, error=f"no borrowable session for {domain}: {str(e)[:120]}")
    headers = {
        "Cookie": cookie, "User-Agent": ua, "Accept": "application/json",
        "Content-Type": "application/json", "Origin": origin, "Referer": origin + "/",
        **derive_csrf_headers(url, cookie),
    }
    try:
        status, text = issue_request(method, url, body, headers)
    except Exception as e:
        return ReplayOutcome(ok=False, error=str(e)[:160], latency_ms=int((time.monotonic() - t0) * 1000))
    return outcome_from_response(status, text, int((time.monotonic() - t0) * 1000))
