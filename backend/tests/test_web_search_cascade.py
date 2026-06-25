"""Fast-first, bounded web-search cascade (/api/web/search).

Pins the behaviour that fixes the ~75s stall and the human-speed goal:
  - DuckDuckGo is tried FIRST and short-circuits the chain when it has results.
  - When DDG is throttled, the chain falls over to the grounded backends.
  - Every attempt is wait_for-bounded, so a hung provider can't stall the request.
  - The `primary` hint reorders only the grounded tier.
  - When everything fails we return an honest message, not a bogus empty result.

All providers are mocked, so the test is deterministic and offline.
"""

import asyncio
import time

import pytest

import backend.apps.web.web as W
from backend.apps.web.web import search, SearchBody
from backend.apps.agents.tools.web import WebSearchTool, DDGRateLimited


@pytest.fixture(autouse=True)
def p_no_network(monkeypatch):
    # Default everything to "unavailable / no network"; each test opts paths in.
    monkeypatch.setattr(W, "p_resolve_gemini_api_key", lambda: None)
    monkeypatch.setattr(W, "p_resolve_openai_api_key", lambda: None)

    async def p_no_subs():
        return set()
    monkeypatch.setattr(W, "p_refresh_9r_connected", p_no_subs)

    async def p_empty(*a, **k):
        return {}
    # subscription helpers hit localhost:20128 otherwise
    monkeypatch.setattr(W, "p_gemini_grounded_via_9router", p_empty)
    monkeypatch.setattr(W, "p_openai_websearch_via_9router", p_empty)


def p_ddg_returns(monkeypatch, text):
    async def p_f(query, num):
        return text
    monkeypatch.setattr(WebSearchTool, "search_ddg", staticmethod(p_f))


def p_ddg_throttled(monkeypatch):
    async def p_f(query, num):
        raise DDGRateLimited(query)
    monkeypatch.setattr(WebSearchTool, "search_ddg", staticmethod(p_f))


@pytest.mark.asyncio
async def test_ddg_is_tried_first_and_wins(monkeypatch):
    p_ddg_returns(monkeypatch, "[1] Foo\n    https://foo.example")
    # grounded would raise if reached; prove it isn't
    async def p_boom(*a, **k):
        raise AssertionError("grounded should not be called when DDG has results")
    monkeypatch.setattr(W, "p_gemini_grounded_call", p_boom)

    t = time.monotonic()
    res = await search(SearchBody(query="foo"))
    assert res["backend"] == "ddg"
    assert "foo.example" in res["results"]
    assert "cascade_errors" not in res
    assert time.monotonic() - t < 1.0


@pytest.mark.asyncio
async def test_ddg_throttled_falls_over_to_openai(monkeypatch):
    p_ddg_throttled(monkeypatch)
    monkeypatch.setattr(W, "p_resolve_openai_api_key", lambda: "okey")

    async def p_openai(api_key, query):
        return {"text": "grounded answer", "chunks": [("Title", "https://u.example")]}
    monkeypatch.setattr(W, "p_openai_websearch", p_openai)

    res = await search(SearchBody(query="x"))
    assert res["backend"] == "openai_native"
    assert "u.example" in res["results"]
    # DDG's throttle is recorded so the caller knows why we fell through
    assert any("ddg" in e for e in res.get("cascade_errors", []))


@pytest.mark.asyncio
async def test_a_hung_grounded_attempt_is_bounded(monkeypatch):
    p_ddg_throttled(monkeypatch)
    monkeypatch.setattr(W, "P_GROUNDED_ATTEMPT_TIMEOUT", 0.3)
    monkeypatch.setattr(W, "p_resolve_gemini_api_key", lambda: "gkey")

    async def p_hangs(*a, **k):
        await asyncio.sleep(30)
    monkeypatch.setattr(W, "p_gemini_grounded_call", p_hangs)

    t = time.monotonic()
    res = await search(SearchBody(query="x"))
    elapsed = time.monotonic() - t
    assert elapsed < 2.0, f"hung provider should be bounded, took {elapsed:.2f}s"
    assert res["backend"] == "none"
    assert any("timed out" in e for e in res["cascade_errors"])


@pytest.mark.asyncio
async def test_primary_openai_reorders_grounded_tier(monkeypatch):
    p_ddg_throttled(monkeypatch)
    monkeypatch.setattr(W, "p_resolve_gemini_api_key", lambda: "gkey")
    monkeypatch.setattr(W, "p_resolve_openai_api_key", lambda: "okey")

    async def p_gem(*a, **k):
        return {"text": "GEM", "chunks": [("g", "https://gem.example")]}
    async def p_oai(api_key, query):
        return {"text": "OAI", "chunks": [("o", "https://oai.example")]}
    monkeypatch.setattr(W, "p_gemini_grounded_call", p_gem)
    monkeypatch.setattr(W, "p_openai_websearch", p_oai)

    res = await search(SearchBody(query="x", primary="openai"))
    # openai must be tried before gemini when it's the primary
    assert res["backend"] == "openai_native"
    assert "oai.example" in res["results"]


@pytest.mark.asyncio
async def test_everything_fails_is_honest_not_empty(monkeypatch):
    p_ddg_throttled(monkeypatch)  # no keys, no subs (from fixture)
    res = await search(SearchBody(query="obscure thing"))
    assert res["backend"] == "none"
    assert "obscure thing" in res["results"]
    # points the user at how to get reliable search
    assert "Settings" in res["results"] or "API key" in res["results"]


# -------------------------------------------------------------------------- /fetch mirrors /search: local httpx + trafilatura is the fast path, grounded fetchers are the fallback for JS/paywalled pages, every attempt is bounded. --------------------------------------------------------------------------

from backend.apps.web.web import fetch, FetchBody
from backend.apps.agents.tools.web import WebFetchTool
import backend.apps.agents.tools.ssrf_guard as p_ssrf


@pytest.fixture(autouse=True)
def p_allow_urls(monkeypatch):
    async def p_ok(url):
        return None
    monkeypatch.setattr(p_ssrf, "assert_safe_url", p_ok)


def p_local_returns(monkeypatch, text):
    async def p_exec(self, input_data, context):
        return [{"type": "text", "text": text}]
    monkeypatch.setattr(WebFetchTool, "execute", p_exec)


@pytest.mark.asyncio
async def test_fetch_local_first_wins_and_is_fast(monkeypatch):
    big = "Contents of https://x.example:\n\n" + ("real article body " * 50)
    p_local_returns(monkeypatch, big)
    async def p_boom(*a, **k):
        raise AssertionError("grounded fetch should not run when local has content")
    monkeypatch.setattr(W, "p_gemini_grounded_call", p_boom)

    t = time.monotonic()
    res = await fetch(FetchBody(url="https://x.example"))
    assert res["backend"] == "local"
    assert "real article body" in res["content"]
    assert time.monotonic() - t < 1.0


@pytest.mark.asyncio
async def test_fetch_thin_local_falls_to_grounded(monkeypatch):
    p_local_returns(monkeypatch, "Contents of https://spa.example:\n\n")  # JS wall, empty body
    monkeypatch.setattr(W, "p_resolve_gemini_api_key", lambda: "gkey")
    async def p_gem(api_key, prompt, *, use_url_context):
        return {"text": "rendered page text from grounding", "chunks": []}
    monkeypatch.setattr(W, "p_gemini_grounded_call", p_gem)

    res = await fetch(FetchBody(url="https://spa.example"))
    assert res["backend"] == "gemini_native"
    assert "rendered page text" in res["content"]


@pytest.mark.asyncio
async def test_fetch_local_error_returned_as_last_resort(monkeypatch):
    p_local_returns(monkeypatch, "HTTP error 403 fetching https://blocked.example")
    # no grounded keys/subs (autouse fixtures) -> all grounded skip/fail
    res = await fetch(FetchBody(url="https://blocked.example"))
    assert res["backend"] == "local"
    assert "HTTP error 403" in res["content"]
