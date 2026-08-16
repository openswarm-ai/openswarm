"""Shared fixtures for the /api/web cascade tests: everything offline by default."""

import pytest

import backend.apps.agents.tools.fetch.wayback as WB
import backend.apps.agents.tools.search.search_bing as SBI
import backend.apps.agents.tools.search.search_brave as SBR
from backend.apps.agents.tools.search.engine_answer import EngineAnswer
import backend.apps.web.web as W
from backend.apps.agents.tools.web import DDGRateLimited, WebSearchTool
import backend.apps.agents.tools.ssrf_guard as p_ssrf
from backend.apps.web.tier_breaker import reset_tier_health


@pytest.fixture(autouse=True)
def fresh_breaker():
    # The breaker is per-process by design, so without this one test's forced outage cools the next test's tier.
    reset_tier_health()
    yield
    reset_tier_health()


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    # Default everything to "unavailable / no network"; each test opts paths in.
    monkeypatch.setattr(W, "resolve_gemini_api_key", lambda: None)
    monkeypatch.setattr(W, "resolve_openai_api_key", lambda: None)

    async def p_no_subs():
        return set()
    monkeypatch.setattr(W, "refresh_9r_connected", p_no_subs)

    async def p_empty(*a, **k):
        return {}
    # subscription helpers hit localhost:20128 otherwise
    monkeypatch.setattr(W, "gemini_grounded_via_9router", p_empty)
    monkeypatch.setattr(W, "openai_websearch_via_9router", p_empty)

    async def p_engine_closed(query, num):
        return EngineAnswer()
    monkeypatch.setattr(SBR, "search_brave", p_engine_closed)
    monkeypatch.setattr(SBI, "search_bing", p_engine_closed)

    async def p_no_snapshot(url):
        return None
    monkeypatch.setattr(WB, "fetch_wayback", p_no_snapshot)


@pytest.fixture(autouse=True)
def allow_urls(monkeypatch):
    async def p_ok(url):
        return None
    monkeypatch.setattr(p_ssrf, "assert_safe_url", p_ok)


def ddg_returns(monkeypatch, text):
    async def p_f(query, num):
        return text
    monkeypatch.setattr(WebSearchTool, "search_ddg", staticmethod(p_f))


def ddg_throttled(monkeypatch):
    async def p_f(query, num):
        raise DDGRateLimited(query)
    monkeypatch.setattr(WebSearchTool, "search_ddg", staticmethod(p_f))


def bing_returns(monkeypatch, text):
    async def p_f(query, num):
        return EngineAnswer(results=text)
    monkeypatch.setattr(SBI, "search_bing", p_f)


def bing_refuses(monkeypatch):
    async def p_f(query, num):
        return EngineAnswer(refused=True)
    monkeypatch.setattr(SBI, "search_bing", p_f)


def brave_returns(monkeypatch, text):
    async def p_f(query, num):
        return EngineAnswer(results=text)
    monkeypatch.setattr(SBR, "search_brave", p_f)


def brave_refuses(monkeypatch):
    async def p_f(query, num):
        return EngineAnswer(refused=True)
    monkeypatch.setattr(SBR, "search_brave", p_f)


def patch_browser_bridge(monkeypatch, result):
    """Patch the offscreen-browser bridge; result=None simulates 'no Electron main bridge connected'."""
    async def p_f(action, params):
        return result
    monkeypatch.setattr(W, "p_browser_bridge", p_f)
