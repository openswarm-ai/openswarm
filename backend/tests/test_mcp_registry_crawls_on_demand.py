"""The 21k-server MCP registry crawl must be demand-driven, not unconditional (ENG-288).

Measured on the shipped tree: `mcp_registry_lifespan` armed the refresh task at boot, and
the loop then fetched the whole official registry (100 entries a page, ~215 sequential
requests against a live count of 21,403), scraped Google's catalogue, and ran a GitHub
star batch. Immediately, then every 3600s, forever, for every user, whether or not they
ever opened the Tools page that consumes it.

The cache is an in-memory dict with no disk persistence, so a restart pays the full cold
crawl again. And the star pass cannot finish by construction: unauthenticated
`GITHUB_BATCH` is 50 repos/hour against 21,403, which is 400+ hours of uninterrupted
uptime into a cache that resets on restart.

The browser IS a real consumer (11 imports, live in Tools, ungated), so this must stay
lazy rather than be deleted: the fix is that only a request can arm the crawl.

Run:
    backend/.venv/bin/python -m pytest backend/tests/test_mcp_registry_crawls_on_demand.py -v
"""

from typing import Any

import pytest

from backend.apps.mcp_registry import mcp_registry


@pytest.fixture(autouse=True)
def p_no_network(monkeypatch: Any) -> None:
    """Nothing here may touch the network; we are counting intent, not results."""
    async def p_refuse(*args: Any, **kwargs: Any) -> dict:
        raise AssertionError("the crawl reached the network during a test")
    monkeypatch.setattr(mcp_registry, "p_fetch_all_servers", p_refuse)
    monkeypatch.setattr(mcp_registry, "p_fetch_google_servers", p_refuse)


@pytest.mark.asyncio
async def test_boot_does_not_start_the_crawl(monkeypatch: Any) -> None:
    """An app that boots and sits idle must issue zero registry requests."""
    started: list[str] = []
    monkeypatch.setattr(mcp_registry, "arm_registry_refresh", lambda: started.append("armed"))
    async with mcp_registry.mcp_registry_lifespan():
        pass
    assert started == [], (
        "boot armed the registry crawl; an idle app pays ~215 requests/hour for a page "
        "the user never opened"
    )


@pytest.mark.asyncio
async def test_asking_for_the_registry_arms_it(monkeypatch: Any) -> None:
    """The other direction: the feature must still work when someone opens Tools."""
    started: list[str] = []
    monkeypatch.setattr(mcp_registry, "p_start_refresh_task", lambda: started.append("armed"))
    mcp_registry.p_refresh_task = None
    mcp_registry.arm_registry_refresh()
    assert started == ["armed"], "opening the registry did not start the crawl, so search stays empty"


@pytest.mark.asyncio
async def test_arming_twice_starts_one_crawl(monkeypatch: Any) -> None:
    """Bounded by construction: N requests must not mean N crawlers."""
    started: list[str] = []

    def p_fake_start() -> None:
        started.append("armed")
        mcp_registry.p_refresh_task = object()

    monkeypatch.setattr(mcp_registry, "p_start_refresh_task", p_fake_start)
    mcp_registry.p_refresh_task = None
    for _ in range(5):
        mcp_registry.arm_registry_refresh()
    assert started == ["armed"], f"armed {len(started)} crawlers for 5 requests"
    mcp_registry.p_refresh_task = None
