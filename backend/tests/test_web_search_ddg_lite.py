"""DDG lite fallback: free search must survive an html.duckduckgo.com throttle.

The field failure (Alex, 1.5.4): DDG's html endpoint 202-throttled and a
subscription-only user (no Gemini/OpenAI key) got "No results / no search
backend configured" for every query, free search had a single point of failure.
The seal: on html-202 OR html-parse-drift (200 with zero entries), search_ddg
falls to lite.duckduckgo.com; only BOTH throttling raises DDGRateLimited.

Network is mocked; the lite fixture is the real markup shape captured live
2026-07-07 (single-quoted class attrs, direct hrefs, paired snippet rows).
"""

import asyncio

import httpx
import pytest

from backend.apps.agents.tools.web import WebSearchTool, DDGRateLimited
from backend.apps.agents.tools.search_ddg_lite import parse_lite_results

P_LITE_BODY = """
<table>
  <tr><td>1.&nbsp;</td><td>
    <a rel="nofollow" href="https://www.anthropic.com/claude/fable" class='result-link'>Claude <b>Fable</b> \\ Anthropic</a>
  </td></tr>
  <tr><td>&nbsp;</td><td class='result-snippet'><b>Claude</b> <b>Fable</b> 5 is a real step forward.</td></tr>
  <tr><td>2.&nbsp;</td><td>
    <a rel="nofollow" href="https://techcrunch.com/2026/06/09/story" class='result-link'>TechCrunch story</a>
  </td></tr>
  <tr><td>&nbsp;</td><td class='result-snippet'>Second snippet text.</td></tr>
</table>
"""

P_HTML_202_BODY = "anomaly detected, challenge page"


class p_FakeResp:
    def __init__(self, status_code: int, text: str):
        self.status_code = status_code
        self.text = text

    def raise_for_status(self):
        if self.status_code >= 400:
            raise httpx.HTTPStatusError("err", request=None, response=None)


class p_RoutedClient:
    """Fake AsyncClient that answers per-URL, so the html and lite endpoints can behave differently in one test."""
    def __init__(self, routes: dict):
        self.routes = routes

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def post(self, url, *a, **k):
        for key, resp in self.routes.items():
            if key in url:
                return resp
        raise AssertionError(f"unexpected URL {url}")


def p_route(monkeypatch, routes: dict):
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **k: p_RoutedClient(routes))


def test_lite_parser_on_real_shape():
    out = parse_lite_results(P_LITE_BODY, 5)
    assert "[1] Claude Fable \\ Anthropic" in out
    assert "https://www.anthropic.com/claude/fable" in out
    assert "Claude Fable 5 is a real step forward." in out
    assert "[2] TechCrunch story" in out
    assert "Second snippet text." in out


def test_lite_parser_respects_num_results():
    out = parse_lite_results(P_LITE_BODY, 1)
    assert "[1]" in out and "[2]" not in out


def test_html_throttle_falls_to_lite(monkeypatch):
    p_route(monkeypatch, {
        "html.duckduckgo.com": p_FakeResp(202, P_HTML_202_BODY),
        "lite.duckduckgo.com": p_FakeResp(200, P_LITE_BODY),
    })
    out = asyncio.run(WebSearchTool.search_ddg("q", 5))
    assert "Claude Fable" in out  # lite answered despite html throttle


def test_both_throttled_raises_rate_limited(monkeypatch):
    p_route(monkeypatch, {
        "html.duckduckgo.com": p_FakeResp(202, P_HTML_202_BODY),
        "lite.duckduckgo.com": p_FakeResp(202, P_HTML_202_BODY),
    })
    with pytest.raises(DDGRateLimited):
        asyncio.run(WebSearchTool.search_ddg("q", 5))


def test_html_markup_drift_falls_to_lite(monkeypatch):
    p_route(monkeypatch, {
        "html.duckduckgo.com": p_FakeResp(200, "<html><body>totally new markup</body></html>"),
        "lite.duckduckgo.com": p_FakeResp(200, P_LITE_BODY),
    })
    out = asyncio.run(WebSearchTool.search_ddg("q", 5))
    assert "Claude Fable" in out  # drift didn't silently become "no results"
