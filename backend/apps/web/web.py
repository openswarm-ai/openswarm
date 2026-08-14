"""Web search + fetch sub-app.

Thin HTTP wrappers around the keyless search rungs and `WebFetchTool` from
`backend.apps.agents.tools`. Exists so the in-process MCP server
(`backend.apps.agents.web_mcp_server`) can proxy tool calls to the backend
instead of re-implementing scraping + trafilatura extraction in the MCP
process.

Mounted at `/api/web`.
"""

from contextlib import asynccontextmanager
from typing import Any, Dict, List, Optional
from uuid import uuid4

from fastapi import HTTPException
from pydantic import BaseModel, Field
from typeguard import typechecked

from backend.apps.web.cascade import CascadeTier, run_cascade
from backend.apps.web.keyless_race import KeylessEngine, race_keyless
from backend.apps.web.grounded import (
    format_grounded_as_fetch,
    format_grounded_as_search_results,
    gemini_grounded_call,
    gemini_grounded_via_9router,
    openai_urlfetch,
    openai_websearch,
    openai_websearch_via_9router,
    refresh_9r_connected,
    resolve_gemini_api_key,
    resolve_openai_api_key,
)
from backend.config.Apps import SubApp


@asynccontextmanager
async def web_lifespan():
    yield


web = SubApp("web", web_lifespan)


# --------------------------------------------------------------------------- Request models ---------------------------------------------------------------------------


class SearchBody(BaseModel):
    query: str = Field(..., description="The search query.")
    num_results: int = Field(5, ge=1, le=10, description="Max results to return.")
    # Hint from the MCP server about which primary provider the session is using. Lets us route to that provider's native search tool (Gemini googleSearch, OpenAI web_search_preview) when available, costs come out of the user's existing primary budget.
    primary: Optional[str] = Field(None, description="Primary provider hint: 'gemini' | 'openai' | 'anthropic' | None")
    # Set by the openswarm-web shim from OPENSWARM_BROWSER_OK; the browser-fallback nudge must never fire in a session without browser-delegation tools.
    browser_ok: bool = Field(False, description="Whether this session has browser-delegation tools available.")


class FetchBody(BaseModel):
    url: str = Field(..., description="The URL to fetch.")
    prompt: Optional[str] = Field(None, description="Optional context hint.")
    primary: Optional[str] = Field(None, description="Primary provider hint.")


# --------------------------------------------------------------------------- Budgets ---------------------------------------------------------------------------

# Whole-cascade wall clock. Nothing below can push an endpoint past this, and the MCP shim waits LONGER (see web_mcp_server) so our honest "here is why every backend failed" answer beats a client-side abort.
SEARCH_BUDGET_SECONDS = 60.0
FETCH_BUDGET_SECONDS = 60.0

KEYLESS_TIER_SECONDS = 8.0        # a search frontend answers in ~1s; >8s is a hang
BROWSER_TIER_SECONDS = 12.0       # the main-bridge send has its own per-action timeout
GROUNDED_TIER_SECONDS = 45.0      # grounded native search legitimately takes 30-42s
LOCAL_FETCH_TIER_SECONDS = 15.0   # normal pages return in <2s
ARCHIVE_TIER_SECONDS = 10.0       # the Wayback redirect path answered in 0.5-3s


# --------------------------------------------------------------------------- Helpers ---------------------------------------------------------------------------


# Drive the packaged app's offscreen Chromium (main-process hidden window) for a fetch/search. Returns the bridge result dict, or None when no Electron main bridge is connected (dev/headless/backend-only) so the cascade just skips this tier. This is the real "browser reachable" gate, OPENSWARM_BROWSER_OK is effectively always "1" and not trustworthy for this.
@typechecked
async def p_browser_bridge(action: str, params: Dict) -> Optional[Dict]:
    from backend.apps.agents.core.ws_manager import ws_manager
    if ws_manager.main_connection is None:
        return None
    res = await ws_manager.send_main_command(uuid4().hex, action, params)
    if not res or res.get("error"):
        return None
    return res


# When every search backend fails, point the model at the in-product browser (always-on CreateBrowserAgent tool) instead of telling it to "wait and retry", which it can't do and just relays as a dead end. A real Chromium carries a real browser fingerprint, which is what the challenge is actually keyed on.
@typechecked
def p_browser_fallback_nudge(query: str) -> str:
    return (
        "Don't stop here: fall back to the in-product browser, which renders real pages and "
        "isn't subject to this block. Call CreateBrowserAgent with a task like: "
        f'"Search the web for: {query}. Report the top results with their titles and URLs, '
        'plus a direct answer if you find one."'
    )


@typechecked
def p_grounded_tiers(kind: str, primary: Optional[str], runners: Dict[str, Any]) -> List[CascadeTier]:
    """Order the four grounded backends, promoting the session's own primary."""
    names = ["gemini_native", "gemini_subscription", "openai_native", "openai_subscription"]
    if (primary or "").lower() == "openai":
        names = names[2:] + names[:2]
    return [
        CascadeTier(name=f"{kind}:{n}", run=runners[n], budget=GROUNDED_TIER_SECONDS)
        for n in names
    ]


# --------------------------------------------------------------------------- Endpoints ---------------------------------------------------------------------------


@web.router.post("/search")
@typechecked
async def search(body: SearchBody) -> Dict:
    """Web search, primary-aware.

    Free keyless rungs lead (they answer at human speed and cost nothing),
    then the packaged app's real browser, then the provider-grounded backends
    of whichever provider the user already pays for."""
    gemini_key = resolve_gemini_api_key()
    openai_key = resolve_openai_api_key()

    async def try_keyless() -> Optional[Dict]:
        # DuckDuckGo (html then lite); sub-second when it isn't challenged. None on a real no-hits so the chain falls through.
        from backend.apps.agents.tools.web import DDGRateLimited, WebSearchTool
        try:
            text = await WebSearchTool.search_ddg(body.query, body.num_results)
        except DDGRateLimited:
            # Surface the challenge as a recorded error (not a silent None) so the caller can see WHY we fell through to a slower backend.
            raise RuntimeError("DuckDuckGo served its bot challenge (HTTP 202)") from None
        if not text:
            return None
        return {"query": body.query, "results": text, "backend": "ddg"}

    async def try_startpage() -> Optional[Dict]:
        # Google's index, when its proof-of-work wall is down; benched by the breaker while it isn't.
        from backend.apps.agents.tools.search.search_startpage import search_startpage
        answer = await search_startpage(body.query, body.num_results)
        # Raise rather than return None: a refusal is the engine failing, and the breaker must count it so a closed Startpage stops costing its budget too.
        if answer.refused:
            raise RuntimeError("Startpage answered with a challenge instead of results")
        if not answer.results:
            return None
        return {"query": body.query, "results": answer.results, "backend": "startpage"}

    async def try_bing() -> Optional[Dict]:
        # The index DuckDuckGo mostly serves, reachable directly even while DDG's challenge wall is up; went 50/50 on a zero-delay burst that tripped both DDG and Brave.
        from backend.apps.agents.tools.search.search_bing import search_bing
        answer = await search_bing(body.query, body.num_results)
        if answer.refused:
            raise RuntimeError("Bing answered with a challenge instead of results")
        if not answer.results:
            return None
        return {"query": body.query, "results": answer.results, "backend": "bing"}

    async def try_brave() -> Optional[Dict]:
        # Brave's own crawler: coverage independent of both Bing-fed engines and Google, but it throttles bursts, so it sits behind Bing and only sees rescue traffic.
        from backend.apps.agents.tools.search.search_brave import search_brave
        answer = await search_brave(body.query, body.num_results)
        if answer.refused:
            raise RuntimeError("Brave answered with a challenge instead of results")
        if not answer.results:
            return None
        return {"query": body.query, "results": answer.results, "backend": "brave"}

    async def try_browser_search() -> Optional[Dict]:
        # Packaged-app tier: a real Chromium's fingerprint isn't subject to the headless-client challenge, and it can scrape Google/Bing directly. Skipped (None) when no Electron main bridge is connected.
        res = await p_browser_bridge("browser_search", {"query": body.query, "num_results": body.num_results})
        if not res or not res.get("results"):
            return None
        return {"query": body.query, "results": res["results"], "backend": f"browser_{res.get('engine', 'search')}"}

    async def try_gemini() -> Optional[Dict]:
        if not gemini_key:
            return None
        grounded = await gemini_grounded_call(
            gemini_key,
            f"Search the web for: {body.query}\n\nReturn a concise summary of what you found. Cite sources.",
            use_url_context=False,
        )
        return {"query": body.query, "results": format_grounded_as_search_results(grounded, body.query),
                "backend": "gemini_native"}

    async def try_openai() -> Optional[Dict]:
        if not openai_key:
            return None
        grounded = await openai_websearch(openai_key, body.query)
        return {"query": body.query, "results": format_grounded_as_search_results(grounded, body.query),
                "backend": "openai_native"}

    async def try_gemini_subscription() -> Optional[Dict]:
        grounded = await gemini_grounded_via_9router(
            f"Search the web for: {body.query}\n\nReturn a concise summary of what you found. Cite sources.",
            False,
        )
        if not grounded.get("text"):
            return None
        return {"query": body.query, "results": format_grounded_as_search_results(grounded, body.query),
                "backend": "gemini_subscription"}

    async def try_openai_subscription() -> Optional[Dict]:
        grounded = await openai_websearch_via_9router(body.query)
        if not grounded.get("text"):
            return None
        return {"query": body.query, "results": format_grounded_as_search_results(grounded, body.query),
                "backend": "openai_subscription"}

    # Collected out-of-band because the race reports per-engine outcomes and a cascade tier can only report one.
    keyless_errors: List[str] = []

    async def try_keyless_engines() -> Optional[Dict]:
        outcome = await race_keyless(
            # Order is quality, not alphabet: race_keyless starts these in sequence and only hedges
            # the next one in if the leader stalls, so whoever sits second inherits every ddg
            # challenge. Measured 2026-08-13, N=22 fact queries, 12s pacing so nobody is being read
            # through their own rate limiter: ddg 21/22 (0.955), bing 6/22 (0.273), brave 2/2 of the
            # 2 it served before throttling, startpage 0/22. Bing answers something 100% of the time
            # and answers CORRECTLY about a quarter of it, which is the worst shape for a silent
            # fallback, so it goes last. The dead rungs cost nothing: record_tier_failure cools them
            # out after their first miss.
            [KeylessEngine(name="ddg", run=try_keyless),
             KeylessEngine(name="brave", run=try_brave),
             KeylessEngine(name="startpage", run=try_startpage),
             KeylessEngine(name="bing", run=try_bing)],
            KEYLESS_TIER_SECONDS,
        )
        keyless_errors.extend(outcome.errors)
        return outcome.result

    tiers = [
        CascadeTier(name="keyless", run=try_keyless_engines, budget=KEYLESS_TIER_SECONDS),
        CascadeTier(name="browser_search", run=try_browser_search, budget=BROWSER_TIER_SECONDS),
    ] + p_grounded_tiers("search", body.primary, {
        "gemini_native": try_gemini,
        "gemini_subscription": try_gemini_subscription,
        "openai_native": try_openai,
        "openai_subscription": try_openai_subscription,
    })

    outcome = await run_cascade(tiers, SEARCH_BUDGET_SECONDS)
    outcome.errors = keyless_errors + [e for e in outcome.errors if not e.startswith("keyless:")]
    if outcome.result is not None:
        if outcome.errors:
            outcome.result["cascade_errors"] = outcome.errors
        return outcome.result

    # Nothing refused us, the engines simply had no matches; saying otherwise sends the model hunting for an outage that isn't there.
    if not keyless_errors:
        return {
            "query": body.query,
            "results": f"No results for: {body.query}\n\nThe search engines answered normally "
                       "and had no matches for this query.",
            "backend": "none",
        }

    # Everything failed. Be honest about why instead of an empty "no results".
    connected = await refresh_9r_connected()
    has_subscription = bool(connected & {"codex", "antigravity", "gemini-cli"})
    if not (gemini_key or openai_key or has_subscription):
        tail = (
            "Every free search frontend refused this request and no paid search backend "
            "is configured. Connect Codex / Antigravity / Gemini CLI in Settings, or add "
            "an OpenAI / Gemini API key, for reliable search."
        )
    else:
        tail = (
            "Every free search frontend refused this request and every configured "
            "provider errored (see details below)."
        )
    nudge = p_browser_fallback_nudge(body.query) if body.browser_ok else ""
    results_text = f"No results for: {body.query}\n\n{tail}" + (f"\n\n{nudge}" if nudge else "")
    return {
        "query": body.query,
        "results": results_text,
        "backend": "none",
        "cascade_errors": outcome.errors,
    }


@web.router.post("/fetch")
@typechecked
async def fetch(body: FetchBody) -> Dict:
    """Fetch a URL, primary-aware. Mirrors the /search cascade."""
    # Belt-and-suspenders: even though we delegate to remote Gemini/OpenAI fetchers (which can't reach private IPs), validating the URL here means a private/metadata URL gets a 4xx instead of being silently forwarded.
    from backend.apps.agents.tools.ssrf_guard import DomainUnreachable, SSRFBlocked, assert_safe_url
    try:
        await assert_safe_url(body.url)
    except DomainUnreachable:
        # A domain that no longer resolves is the archive's whole reason for existing, so let the cascade run instead of 400ing here.
        pass
    except SSRFBlocked as exc:
        raise HTTPException(status_code=400, detail=f"Refused: {exc}")
    gemini_key = resolve_gemini_api_key()
    openai_key = resolve_openai_api_key()

    # Remembered so a thin/errored local read is still returned as the last resort if every other tier also fails (never worse than before).
    local_text: Optional[str] = None

    async def try_local() -> Optional[Dict]:
        # Fast path: direct httpx + trafilatura, and it returns the page's ACTUAL text (the grounded fetchers summarize, which is slower and loses detail). Thin/errored reads (JS walls, paywalls, HTTP errors) fall through.
        nonlocal local_text
        from backend.apps.agents.tools.web import WebFetchTool
        page = await WebFetchTool.fetch_page(body.url, body.prompt)
        local_text = page.text
        if page.kind == "error":
            return None
        # A PNG or a scanned PDF has no text for ANY tier to find, so spending a paid fetcher on it buys nothing.
        if page.kind in ("binary", "pdf_unreadable"):
            return {"url": body.url, "content": page.text, "backend": "local"}
        body_text = page.text.split("\n\n", 1)[-1]
        if len(body_text.strip()) < 200:
            return None
        # A challenge screen answers 200 and reads like prose, and it is exactly what our own Chromium on the user's own IP can get past, so never stop here for one.
        from backend.apps.agents.tools.fetch.bot_wall import looks_like_bot_wall
        if looks_like_bot_wall(body_text):
            return None
        return {"url": body.url, "content": page.text, "backend": "local"}

    async def try_browser_fetch() -> Optional[Dict]:
        # Packaged-app tier: renders the page in a real offscreen Chromium and returns its visible text, so JS-only / SPA / soft-paywall pages that give httpx nothing actually resolve. Shares the user's browser cookies, so pages they're logged into fetch authed.
        from backend.apps.agents.tools.fetch.bot_wall import looks_like_bot_wall
        res = await p_browser_bridge("browser_fetch", {"url": body.url})
        if not res or not res.get("text"):
            return None
        # Measured live: Cloudflare and PerimeterX beat even a real browser on some sites, and their challenge screen is not the page; the archive still has the real one.
        if looks_like_bot_wall(res["text"]):
            return None
        return {"url": body.url, "content": f"Contents of {body.url}:\n\n{res['text']}", "backend": "browser"}

    async def try_wayback() -> Optional[Dict]:
        # A dead link or a hard bot wall is exactly what the archive is for, and it returns the page's REAL text where a grounded fetcher can only summarise a page it also can't read.
        from backend.apps.agents.tools.fetch.wayback import fetch_wayback
        text = await fetch_wayback(body.url)
        if not text:
            return None
        return {"url": body.url, "content": text, "backend": "wayback"}

    async def try_gemini() -> Optional[Dict]:
        if not gemini_key:
            return None
        prompt_bits = [f"Fetch and summarize this URL: {body.url}"]
        if body.prompt:
            prompt_bits.append(f"Focus on: {body.prompt}")
        grounded = await gemini_grounded_call(gemini_key, "\n".join(prompt_bits), use_url_context=True)
        return {"url": body.url, "content": format_grounded_as_fetch(grounded, body.url),
                "backend": "gemini_native"}

    async def try_openai() -> Optional[Dict]:
        if not openai_key:
            return None
        grounded = await openai_urlfetch(openai_key, body.url, body.prompt)
        return {"url": body.url, "content": format_grounded_as_fetch(grounded, body.url),
                "backend": "openai_native"}

    async def try_gemini_subscription() -> Optional[Dict]:
        prompt_bits = [f"Fetch and summarize this URL: {body.url}"]
        if body.prompt:
            prompt_bits.append(f"Focus on: {body.prompt}")
        grounded = await gemini_grounded_via_9router("\n".join(prompt_bits), True)
        if not grounded.get("text"):
            return None
        return {"url": body.url, "content": format_grounded_as_fetch(grounded, body.url),
                "backend": "gemini_subscription"}

    async def try_openai_subscription() -> Optional[Dict]:
        # Codex's web_search is general; URL fetch via search query works adequately for our use.
        prompt = f"Fetch this URL and summarize: {body.url}"
        if body.prompt:
            prompt += f"\nFocus on: {body.prompt}"
        grounded = await openai_websearch_via_9router(prompt)
        if not grounded.get("text"):
            return None
        return {"url": body.url, "content": format_grounded_as_fetch(grounded, body.url),
                "backend": "openai_subscription"}

    tiers = [
        CascadeTier(name="local", run=try_local, budget=LOCAL_FETCH_TIER_SECONDS),
        CascadeTier(name="browser", run=try_browser_fetch, budget=BROWSER_TIER_SECONDS),
        CascadeTier(name="wayback", run=try_wayback, budget=ARCHIVE_TIER_SECONDS),
    ] + p_grounded_tiers("fetch", body.primary, {
        "gemini_native": try_gemini,
        "gemini_subscription": try_gemini_subscription,
        "openai_native": try_openai,
        "openai_subscription": try_openai_subscription,
    })

    outcome = await run_cascade(tiers, FETCH_BUDGET_SECONDS)
    if outcome.result is not None:
        if outcome.errors:
            outcome.result["cascade_errors"] = outcome.errors
        return outcome.result

    # Every tier failed; hand back whatever the local read got (even an error string is useful signal) rather than nothing.
    if local_text is not None:
        return {"url": body.url, "content": local_text, "backend": "local",
                **({"cascade_errors": outcome.errors} if outcome.errors else {})}
    raise HTTPException(status_code=502, detail=f"Fetch failed for {body.url}: " + "; ".join(outcome.errors)[:400])
