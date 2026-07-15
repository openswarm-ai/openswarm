"""The API-first write tier, unified for the browser agent.

When a write targets a site that has a borrowed-session write adapter, route the write HERE
instead of UI puppeteering: borrow the user's live cookies, call the site's OWN write API, and
return the site's typed receipt (its own id / permalink = proof it landed). This is
deterministic (a typed success/error envelope, no captcha on the API surface, no DOM selector to
drift) and ~50-190x faster than driving the UI (measured Reddit: 271ms vs 13-52s). Adding a site
is one adapter entry; a site with no adapter falls back to the existing UI+model write path.

Live-validated end to end on Reddit (comment 271ms + reversible delete 246ms, typed receipts).
"""

import asyncio
import os
import time
from typing import Any, Callable, Dict, FrozenSet, List, Tuple
from urllib.parse import urlparse

from pydantic import BaseModel, ConfigDict
from typeguard import typechecked

from backend.apps.agents.browser import route_write
from backend.apps.reddit_mcp_shim import reddit_writes


class WriteResult(BaseModel):
    """The typed outcome of an API-first write. `receipt` is the site's own id/permalink, the
    proof the write landed (a real receipt, not a pixel guess); `ok` is False with a legible
    `error` when the site's API rejected it or no session could be borrowed."""

    model_config = ConfigDict(validate_assignment=True)

    ok: bool
    action: str
    domain: str
    receipt: str = ""
    error: str = ""
    latency_ms: int = 0


@typechecked
def p_reddit_dispatch(action: str, params: Dict[str, Any]) -> Dict[str, Any]:
    """Route a generic write action to the proven reddit_writes function; returns its receipt
    dict (raises RedditError on the API's own error envelope, surfaced as ok=False upstream)."""
    if action in ("comment", "reply"):
        return reddit_writes.comment(str(params["parent_id"]), str(params["text"]))
    if action in ("post", "submit"):
        return reddit_writes.submit(
            str(params["subreddit"]), str(params["title"]), str(params.get("kind", "self")),
            str(params.get("text", "")), str(params.get("url", "")),
            bool(params.get("nsfw", False)), bool(params.get("spoiler", False)),
            bool(params.get("send_replies", True)),
        )
    if action == "edit":
        return reddit_writes.edit(str(params["thing_id"]), str(params["text"]))
    if action == "delete":
        return reddit_writes.delete(str(params["thing_id"]))
    raise ValueError(f"reddit adapter has no action {action!r}")


# domain -> (actions it can do via the site's own API, sync dispatch fn). A dynamic-key registry
# keyed by domain; adding a site is one row. X/others plug in the same shape once their write API
# (GraphQL queryId + ct0) is proven, replacing their current UI-driving shim.
P_ADAPTERS: Dict[str, Tuple[FrozenSet[str], Callable[[str, Dict[str, Any]], Dict[str, Any]]]] = {
    "reddit.com": (frozenset({"comment", "reply", "post", "submit", "edit", "delete"}), p_reddit_dispatch),
}


@typechecked
def has_api_write(domain: str, action: str) -> bool:
    """True when this domain has a deterministic API adapter for this write action, so the agent
    should route around the UI puppeteer tier."""
    entry = P_ADAPTERS.get(domain.lower().strip().lstrip("."))
    return bool(entry and action in entry[0])


@typechecked
def receipt_str(receipt: Dict[str, Any]) -> str:
    """Flatten a site receipt dict into the single most-proof-bearing string (permalink beats a
    bare id) so callers get one legible confirmation without knowing each site's shape."""
    for key in ("permalink", "url", "id"):
        v = receipt.get(key)
        if v:
            return str(v)
    return "ok"


@typechecked
def p_ensure_session_env() -> None:
    """Point session_source at the running backend so the in-process agent can borrow cookies the
    same token-gated way the subprocess shims do (module globals are read at import, so patch
    them). No-op once set."""
    from backend.apps.social_shims import session_source as ss
    port = os.environ.get("OPENSWARM_PORT", "8324")
    ss.BACKEND_PORT = port
    ss.BRIDGE_URL = f"http://127.0.0.1:{port}/api/browser-session/cookies"
    if not ss.AUTH_TOKEN:
        try:
            from backend.auth import get_auth_token
            ss.AUTH_TOKEN = get_auth_token() or ""
        except Exception:
            pass


@typechecked
async def api_route_write(origin: str, method: str, url: str, body: Dict[str, Any],
                         captured: List[route_write.CapturedRoute]) -> WriteResult:
    """The GENERAL tier: replay a captured mutating route the site's own UI fired, for sites with
    no hand-written adapter. Wraps route_write's typed outcome into the registry's WriteResult so
    callers get one shape. Every refusal/rejection is ok=False, so the agent falls back to the UI."""
    p_ensure_session_env()
    d = (urlparse(origin).netloc or origin).lstrip(".")
    out = await asyncio.to_thread(route_write.replay_write, method, url, body, origin, captured)
    return WriteResult(ok=out.ok, action="route", domain=d, receipt=out.receipt,
                       error=out.error, latency_ms=out.latency_ms)


@typechecked
async def api_write(domain: str, action: str, params: Dict[str, Any]) -> WriteResult:
    """Perform a write via the site's own API using the borrowed session. Times it, and turns any
    failure (rejected by the site, no session, bad params) into a typed ok=False result rather
    than raising, so the agent can fall back to the UI path on a miss without a crash."""
    d = domain.lower().strip().lstrip(".")
    entry = P_ADAPTERS.get(d)
    if not entry or action not in entry[0]:
        return WriteResult(ok=False, action=action, domain=d,
                           error=f"no API-first adapter for {d}/{action}; use the UI path")
    p_ensure_session_env()
    dispatch = entry[1]
    t0 = time.monotonic()
    try:
        receipt = await asyncio.to_thread(dispatch, action, params)
        return WriteResult(ok=True, action=action, domain=d,
                           receipt=receipt_str(receipt),
                           latency_ms=int((time.monotonic() - t0) * 1000))
    except Exception as e:
        return WriteResult(ok=False, action=action, domain=d, error=str(e)[:200],
                           latency_ms=int((time.monotonic() - t0) * 1000))
