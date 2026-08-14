"""Fast-first, deadline-bounded /api/web/search cascade.

  - The free keyless engines are tried FIRST and short-circuit the chain.
  - One engine's bot challenge falls over to the other, then to the grounded backends.
  - Every attempt is bounded, so a hung provider can't stall the request.
  - The `primary` hint reorders only the grounded tier.
  - When everything fails we return an honest message, not a bogus empty result.

All providers are mocked, so the test is deterministic and offline.
"""

import asyncio
import time

import pytest

import backend.apps.web.web as W
from backend.apps.web.web import search, SearchBody
from backend.tests.web_cascade_fixtures import (  # noqa: F401
    allow_urls,
    bing_refuses,
    bing_returns,
    brave_refuses,
    brave_returns,
    fresh_breaker,
    patch_browser_bridge,
    ddg_returns,
    ddg_throttled,
    no_network,
    startpage_refuses,
    startpage_returns,
)






@pytest.mark.asyncio
async def test_ddg_is_tried_first_and_wins(monkeypatch):
    ddg_returns(monkeypatch, "[1] Foo\n    https://foo.example")
    # grounded would raise if reached; prove it isn't
    async def p_boom(*a, **k):
        raise AssertionError("grounded should not be called when DDG has results")
    monkeypatch.setattr(W, "gemini_grounded_call", p_boom)

    t = time.monotonic()
    res = await search(SearchBody(query="foo"))
    assert res["backend"] == "ddg"
    assert "foo.example" in res["results"]
    assert "cascade_errors" not in res
    assert time.monotonic() - t < 1.0


@pytest.mark.asyncio
async def test_ddg_throttled_falls_over_to_openai(monkeypatch):
    ddg_throttled(monkeypatch)
    monkeypatch.setattr(W, "resolve_openai_api_key", lambda: "okey")

    async def p_openai(api_key, query):
        return {"text": "grounded answer", "chunks": [("Title", "https://u.example")]}
    monkeypatch.setattr(W, "openai_websearch", p_openai)

    res = await search(SearchBody(query="x"))
    assert res["backend"] == "openai_native"
    assert "u.example" in res["results"]
    # DDG's throttle is recorded so the caller knows why we fell through
    assert any("ddg" in e for e in res.get("cascade_errors", []))


@pytest.mark.asyncio
async def test_startpage_rescues_a_ddg_challenge(monkeypatch):
    """Two independent engines: one operator's bot challenge must not close free search."""
    ddg_throttled(monkeypatch)
    startpage_returns(monkeypatch, "[1] Rescued\n    https://sp.example")

    async def p_boom(*a, **k):
        raise AssertionError("a paid backend must not run while a free engine still answers")
    monkeypatch.setattr(W, "gemini_grounded_call", p_boom)

    res = await search(SearchBody(query="x"))
    assert res["backend"] == "startpage"
    assert "sp.example" in res["results"]
    assert any("ddg" in e for e in res["cascade_errors"])


@pytest.mark.asyncio
async def test_a_hung_grounded_attempt_is_bounded(monkeypatch):
    ddg_throttled(monkeypatch)
    monkeypatch.setattr(W, "GROUNDED_TIER_SECONDS", 0.3)
    monkeypatch.setattr(W, "resolve_gemini_api_key", lambda: "gkey")

    async def p_hangs(*a, **k):
        await asyncio.sleep(30)
    monkeypatch.setattr(W, "gemini_grounded_call", p_hangs)

    t = time.monotonic()
    res = await search(SearchBody(query="x"))
    elapsed = time.monotonic() - t
    assert elapsed < 2.0, f"hung provider should be bounded, took {elapsed:.2f}s"
    assert res["backend"] == "none"
    assert any("timed out" in e for e in res["cascade_errors"])


@pytest.mark.asyncio
async def test_primary_openai_reorders_grounded_tier(monkeypatch):
    ddg_throttled(monkeypatch)
    monkeypatch.setattr(W, "resolve_gemini_api_key", lambda: "gkey")
    monkeypatch.setattr(W, "resolve_openai_api_key", lambda: "okey")

    async def p_gem(*a, **k):
        return {"text": "GEM", "chunks": [("g", "https://gem.example")]}
    async def p_oai(api_key, query):
        return {"text": "OAI", "chunks": [("o", "https://oai.example")]}
    monkeypatch.setattr(W, "gemini_grounded_call", p_gem)
    monkeypatch.setattr(W, "openai_websearch", p_oai)

    res = await search(SearchBody(query="x", primary="openai"))
    # openai must be tried before gemini when it's the primary
    assert res["backend"] == "openai_native"
    assert "oai.example" in res["results"]


@pytest.mark.asyncio
async def test_everything_fails_is_honest_not_empty(monkeypatch):
    ddg_throttled(monkeypatch)  # no keys, no subs (from fixture)
    res = await search(SearchBody(query="obscure thing"))
    assert res["backend"] == "none"
    assert "obscure thing" in res["results"]
    # points the user at how to get reliable search
    assert "Settings" in res["results"] or "API key" in res["results"]


@pytest.mark.asyncio
async def test_everything_fails_nudges_browser_not_retry(monkeypatch):
    # All-fail must hand the model the browser as an escape hatch, not a dead-end "wait and retry".
    ddg_throttled(monkeypatch)
    monkeypatch.setattr(W, "resolve_openai_api_key", lambda: "okey")  # configured but errors

    async def p_openai_boom(*a, **k):
        raise RuntimeError("openai down")
    monkeypatch.setattr(W, "openai_websearch", p_openai_boom)

    res = await search(SearchBody(query="sony zv-e10 price", browser_ok=True))
    assert res["backend"] == "none"
    assert "CreateBrowserAgent" in res["results"]
    assert "retry" not in res["results"].lower()


@pytest.mark.asyncio
async def test_nudge_suppressed_when_browser_denied(monkeypatch):
    # A session without browser-delegation tools must never be told to call CreateBrowserAgent.
    ddg_throttled(monkeypatch)
    monkeypatch.setattr(W, "resolve_openai_api_key", lambda: "okey")

    async def p_openai_boom(*a, **k):
        raise RuntimeError("openai down")
    monkeypatch.setattr(W, "openai_websearch", p_openai_boom)

    res = await search(SearchBody(query="sony zv-e10 price"))
    assert res["backend"] == "none"
    assert "CreateBrowserAgent" not in res["results"]
    assert "retry" not in res["results"].lower()


# --- packaged-browser tier: fires when DDG throttles, skipped when no bridge ---

@pytest.mark.asyncio
async def test_browser_search_tier_fires_when_ddg_throttled(monkeypatch):
    ddg_throttled(monkeypatch)
    patch_browser_bridge(monkeypatch, {"engine": "ddg", "results": "[1] Real\n    https://real.example", "count": 1})

    async def p_boom(*a, **k):
        raise AssertionError("grounded should not be reached once the browser tier answers")
    monkeypatch.setattr(W, "gemini_grounded_call", p_boom)

    res = await search(SearchBody(query="q"))
    assert res["backend"] == "browser_ddg"
    assert "real.example" in res["results"]


@pytest.mark.asyncio
async def test_browser_search_skipped_when_no_bridge(monkeypatch):
    # DDG throttled, no browser bridge -> must fall THROUGH to grounded, not crash.
    ddg_throttled(monkeypatch)
    patch_browser_bridge(monkeypatch, None)
    monkeypatch.setattr(W, "resolve_openai_api_key", lambda: "okey")

    async def p_openai(api_key, query):
        return {"text": "grounded", "chunks": [("T", "https://u.example")]}
    monkeypatch.setattr(W, "openai_websearch", p_openai)

    res = await search(SearchBody(query="q"))
    assert res["backend"] == "openai_native"


@pytest.mark.asyncio
async def test_bing_rescues_a_ddg_challenge_before_any_paid_backend(monkeypatch):
    """Bing is the unthrottled second rung: it went 50/50 on the burst that tripped DDG."""
    ddg_throttled(monkeypatch)
    bing_returns(monkeypatch, "[1] Rescued\n    https://bing-hit.example")

    async def p_boom(*a, **k):
        raise AssertionError("a paid backend must not run while a free engine still answers")
    monkeypatch.setattr(W, "gemini_grounded_call", p_boom)

    res = await search(SearchBody(query="x"))
    assert res["backend"] == "bing"
    assert "bing-hit.example" in res["results"]
    assert any("ddg" in e for e in res["cascade_errors"])


@pytest.mark.asyncio
async def test_brave_rescues_when_ddg_refuses(monkeypatch):
    """Brave now sits directly behind ddg, so it is what catches a ddg challenge."""
    ddg_throttled(monkeypatch)
    brave_returns(monkeypatch, "[1] Independent index\n    https://brave-hit.example")

    res = await search(SearchBody(query="x"))
    assert res["backend"] == "brave"
    assert "brave-hit.example" in res["results"]


@pytest.mark.asyncio
async def test_bing_is_the_last_keyless_resort(monkeypatch):
    """Bing answers something ~100% of the time and answers CORRECTLY ~27% (N=22, 12s pacing,
    2026-08-13) against ddg's 95.5%, which is the worst possible shape for a silent fallback: the
    caller cannot tell a good answer from an off-topic one. So it must serve only when every better
    rung has declined, and that ordering is what this pins."""
    ddg_throttled(monkeypatch)
    brave_returns(monkeypatch, "[1] Brave result\n    https://brave-hit.example")
    bing_returns(monkeypatch, "[1] Bing result\n    https://bing-hit.example")

    res = await search(SearchBody(query="x"))
    assert res["backend"] == "brave", (
        f"bing served while brave was also answering, so it is not last: got {res['backend']}"
    )
    assert "bing-hit.example" not in res["results"]


@pytest.mark.asyncio
async def test_a_refusing_startpage_counts_against_it(monkeypatch):
    """A challenge and a genuinely empty web look identical on the wire, and treating a
    refusal as 'no hits' meant a closed Startpage kept costing its full budget forever."""
    from backend.apps.web.tier_breaker import FAILURES_TO_OPEN, tier_cooldown_left
    ddg_throttled(monkeypatch)
    startpage_refuses(monkeypatch)
    for _ in range(FAILURES_TO_OPEN):
        out = await search(SearchBody(query="anything", num_results=5))
        assert out["backend"] == "none"
    assert tier_cooldown_left("startpage") > 0
    assert any("challenge" in e for e in out["cascade_errors"])


@pytest.mark.asyncio
async def test_an_honestly_empty_startpage_does_not_count_against_it(monkeypatch):
    """Nonsense queries must not slowly cool down a perfectly healthy engine."""
    from backend.apps.web.tier_breaker import FAILURES_TO_OPEN, tier_cooldown_left
    ddg_throttled(monkeypatch)
    for _ in range(FAILURES_TO_OPEN + 2):
        out = await search(SearchBody(query="zxqvbnmklwertyuiopasdfg", num_results=5))
        assert out["backend"] == "none"
    assert tier_cooldown_left("startpage") == 0.0


@pytest.mark.asyncio
async def test_a_genuinely_empty_search_does_not_claim_an_outage(monkeypatch):
    """Both engines answering 'no matches' is an answer; calling it a refusal sends the model
    hunting for an outage that isn't there."""
    ddg_returns(monkeypatch, "")
    startpage_returns(monkeypatch, "")
    out = await search(SearchBody(query="xyzzyplughnothinghere1234567", num_results=5))
    assert out["backend"] == "none"
    assert "had no matches" in out["results"]
    assert "refused" not in out["results"]
    assert not out.get("cascade_errors")


@pytest.mark.asyncio
async def test_a_real_outage_still_says_so(monkeypatch):
    ddg_throttled(monkeypatch)
    startpage_refuses(monkeypatch)
    out = await search(SearchBody(query="capital of Burkina Faso", num_results=5))
    assert out["backend"] == "none"
    assert "refused" in out["results"]
    assert out["cascade_errors"]
