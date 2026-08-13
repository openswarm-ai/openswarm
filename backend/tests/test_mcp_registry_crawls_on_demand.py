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


# --- Going lazy cost the feature on a cold open, which is the regression these three cover. ---
#
# Arming is not the same as being ready. The first version of the fix fired the task and then read
# the cache in the same breath, so the first Marketplace open after a boot returned zero servers and
# a detail lookup 404'd for as long as the ~215-request crawl ran. Idle cost went to zero and so did
# the feature. Waiting for the first server list restores it without re-arming anything at boot.


@pytest.fixture
def p_cold_registry() -> Any:
    """Cold cache, crawl already 'armed' so these tests exercise the wait and not the arming."""
    mcp_registry.p_cache = {}
    mcp_registry.p_refresh_task = object()
    yield
    mcp_registry.p_cache = {}
    mcp_registry.p_refresh_task = None


@pytest.mark.asyncio
async def test_a_cold_request_waits_for_the_first_server_list(p_cold_registry: Any) -> None:
    """The regression: a cold open must not be answered with an empty list."""
    import asyncio

    async def p_crawl_finishes_shortly() -> None:
        await asyncio.sleep(0.05)
        mcp_registry.p_cache = {"acme/thing": {"name": "acme/thing"}}

    task = asyncio.create_task(p_crawl_finishes_shortly())
    ready = await mcp_registry.ensure_registry_ready(timeout_s=3.0)
    # Snapshot BEFORE awaiting the crawl: reading the cache afterwards lets the background task fill
    # it in and the test passes even when the wait was skipped entirely. That vacuous version
    # survived the mutation run, which is the whole reason this line exists.
    cache_when_it_returned = mcp_registry.registry_server_count()
    await task

    assert ready is True, "a cold request gave up instead of waiting for the crawl it just armed"
    assert cache_when_it_returned > 0, (
        "returned ready while the cache was still empty, so the Marketplace renders a blank page "
        "on the first open after a boot"
    )


@pytest.mark.asyncio
async def test_a_slow_crawl_never_hangs_the_request(p_cold_registry: Any) -> None:
    """Bounded the other way: nobody sets the gate, so the caller must still get an answer."""
    import time

    t0 = time.perf_counter()
    ready = await mcp_registry.ensure_registry_ready(timeout_s=0.1)
    elapsed = time.perf_counter() - t0

    assert ready is False, "claimed ready while the cache was empty and nothing had loaded"
    assert elapsed < 2.0, f"waited {elapsed:.2f}s on a 0.1s budget, so a slow crawl blocks the request"


@pytest.mark.asyncio
async def test_a_warm_cache_does_not_wait(p_cold_registry: Any) -> None:
    """Every request after the first must be free; a per-request wait would be its own regression."""
    import time

    mcp_registry.p_cache = {"acme/thing": {"name": "acme/thing"}}
    t0 = time.perf_counter()
    ready = await mcp_registry.ensure_registry_ready(timeout_s=5.0)
    elapsed = time.perf_counter() - t0

    assert ready is True
    assert elapsed < 0.05, f"a warm request still waited {elapsed:.3f}s"
