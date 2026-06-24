"""DuckDuckGo parsing robustness: rate-limit (202) and ad-row stripping.

These pin the two bugs that turned DDG into a flaky 'No results found' source:
  1. DDG serves its throttle challenge as HTTP 202 (a 2xx), so raise_for_status()
     missed it and we parsed an empty page as a real empty result set.
  2. Sponsored rows point at DDG's own y.js click-tracker (ad_domain/ad_provider)
     and were emitted as junk 'duckduckgo.com/y.js?...' results.

We mock the network so the test is deterministic and offline.
"""

import httpx
import pytest

from backend.apps.agents.tools.web import WebSearchTool, DDGRateLimited


class p_FakeResp:
    def __init__(self, status_code: int, text: str):
        self.status_code = status_code
        self.text = text

    def raise_for_status(self):
        if self.status_code >= 400:
            raise httpx.HTTPStatusError("err", request=None, response=None)


class p_FakeClient:
    """Stands in for httpx.AsyncClient; returns a canned response."""
    def __init__(self, resp: p_FakeResp):
        self.p_resp = resp

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def post(self, *a, **k):
        return self.p_resp


def p_patch_client(monkeypatch, resp: p_FakeResp):
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **k: p_FakeClient(resp))


# One real organic result + one sponsored (ad) row in DDG's html markup.
P_HTML_WITH_AD = """
<div class="result results_links_deep">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Freal&amp;rut=x">Real Result Title</a>
  <a class="result__snippet">A genuine snippet about the topic.</a>
</div>
<div class="result result--ad">
  <a class="result__a" href="//duckduckgo.com/y.js?ad_domain=advertiser.com&amp;ad_provider=bingv7aa&amp;ad_type=txad">Sponsored Junk</a>
  <a class="result__snippet">Buy now!</a>
</div>
"""


@pytest.mark.asyncio
async def test_202_raises_rate_limited_not_empty(monkeypatch):
    p_patch_client(monkeypatch, p_FakeResp(202, "<html>throttle challenge, no results</html>"))
    with pytest.raises(DDGRateLimited):
        await WebSearchTool.search_ddg("anything", 5)


@pytest.mark.asyncio
async def test_execute_reports_rate_limit_clearly(monkeypatch):
    p_patch_client(monkeypatch, p_FakeResp(202, "throttle"))
    parts = await WebSearchTool().execute({"query": "x", "num_results": 5}, None)
    msg = parts[0]["text"].lower()
    assert "rate-limit" in msg
    assert "no search results" not in msg  # the old bogus message must be gone


@pytest.mark.asyncio
async def test_ads_are_stripped_real_results_kept(monkeypatch):
    p_patch_client(monkeypatch, p_FakeResp(200, P_HTML_WITH_AD))
    out = await WebSearchTool.search_ddg("topic", 5)
    assert "example.com/real" in out
    assert "Real Result Title" in out
    # the sponsored row and its tracker URL must not appear
    assert "y.js" not in out
    assert "advertiser.com" not in out
    assert "Sponsored Junk" not in out


@pytest.mark.asyncio
async def test_genuinely_empty_is_not_a_rate_limit(monkeypatch):
    # 200 with no result blocks is a real empty result set, not a throttle.
    p_patch_client(monkeypatch, p_FakeResp(200, "<html><body>nothing here</body></html>"))
    out = await WebSearchTool.search_ddg("zxcvqwer no hits", 5)
    assert out == ""
