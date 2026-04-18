"""MCP Registry SubApp: caches community + Google servers, enriches with GitHub stars."""

import asyncio
import logging
import os
import time
from contextlib import asynccontextmanager
from typing import Optional

from pydantic import InstanceOf
import httpx
from fastapi import Query
from backend.config.Apps import SubApp
from backend.apps.mcp_registry.registry_fetcher import (
    extract_gh_repo, fetch_all_servers, fetch_google_servers,
)

logger = logging.getLogger(__name__)

REFRESH_INTERVAL_S = 3600

GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN", "")
GITHUB_BATCH = 4000 if GITHUB_TOKEN else 50
GITHUB_CONCURRENT = 10

_cache: dict[str, dict] = {}
_cache_updated_at: float = 0
_refresh_task: Optional[InstanceOf[asyncio.Task]] = None
_stars_cache: dict[str, int] = {}


async def _fetch_github_stars(servers: dict[str, dict]):
    """Batch-fetch GitHub star counts for servers with GitHub repos.

    Uses an in-memory cache so stars accumulate across refresh cycles even
    when rate-limited (60 req/hr unauthenticated, 5 000 with GITHUB_TOKEN).
    """
    global _stars_cache

    needed: list[str] = []
    for srv in servers.values():
        gh = extract_gh_repo(srv.get("repositoryUrl", ""))
        if gh and gh not in _stars_cache and gh not in needed:
            needed.append(gh)

    if not needed:
        logger.info(f"GitHub stars: all {len(_stars_cache)} repos cached, 0 to fetch")
        _apply_stars(servers)
        return

    to_fetch = needed[: GITHUB_BATCH]
    logger.info(
        f"GitHub stars: fetching {len(to_fetch)} repos "
        f"({len(_stars_cache)} cached, {len(needed)} pending)"
    )

    headers: dict[str, str] = {"Accept": "application/vnd.github.v3+json"}
    if GITHUB_TOKEN:
        headers["Authorization"] = f"token {GITHUB_TOKEN}"

    sem = asyncio.Semaphore(GITHUB_CONCURRENT)
    rate_limited = False
    fetched = 0

    async def _fetch_one(client: httpx.AsyncClient, repo: str):
        nonlocal rate_limited, fetched
        if rate_limited:
            return
        async with sem:
            if rate_limited:
                return
            try:
                resp = await client.get(
                    f"https://api.github.com/repos/{repo}", headers=headers
                )
                if resp.status_code == 200:
                    _stars_cache[repo] = resp.json().get("stargazers_count", 0)
                    fetched += 1
                elif resp.status_code in (403, 429):
                    rate_limited = True
                    logger.warning("GitHub API rate-limited, stopping star fetch")
                elif resp.status_code == 404:
                    _stars_cache[repo] = 0
                    fetched += 1
            except Exception as exc:
                logger.debug(f"GitHub stars fetch failed for {repo}: {exc}")

    async with httpx.AsyncClient(timeout=15.0) as client:
        await asyncio.gather(*[_fetch_one(client, r) for r in to_fetch])

    logger.info(f"GitHub stars: fetched {fetched} new, {len(_stars_cache)} total cached")
    _apply_stars(servers)


def _apply_stars(servers: dict[str, dict]):
    for srv in servers.values():
        gh = extract_gh_repo(srv.get("repositoryUrl", ""))
        srv["stars"] = _stars_cache.get(gh) if gh else None


async def _refresh_loop():
    """Background loop that refreshes the cache on startup and then hourly."""
    global _cache, _cache_updated_at
    while True:
        try:
            community, google = await asyncio.gather(
                fetch_all_servers(),
                fetch_google_servers(),
            )
            _cache = {**community, **google}
            await _fetch_github_stars(_cache)
            _cache_updated_at = time.time()
        except Exception as e:
            logger.exception(f"MCP registry refresh error: {e}")
        await asyncio.sleep(REFRESH_INTERVAL_S)


@asynccontextmanager
async def mcp_registry_lifespan():
    global _refresh_task
    _refresh_task = asyncio.create_task(_refresh_loop())
    yield
    if _refresh_task:
        _refresh_task.cancel()
        try:
            await _refresh_task
        except asyncio.CancelledError:
            pass


mcp_registry = SubApp("mcp-registry", mcp_registry_lifespan)


@mcp_registry.router.get("/stats")
async def registry_stats():
    google = sum(1 for s in _cache.values() if s.get("source") == "google")
    community = sum(1 for s in _cache.values() if s.get("source") == "community")
    return {
        "total": len(_cache),
        "google": google,
        "community": community,
        "lastUpdated": _cache_updated_at,
    }


@mcp_registry.router.get("/search")
async def registry_search(
    q: str = Query("", description="Search query"),
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
    sort: str = Query("name", description="Sort by: name, stars"),
    source: str = Query("", description="Filter by source: google, community, or empty for all"),
):
    pool = _cache.values()
    if source:
        pool = [s for s in pool if s.get("source") == source]

    query_lower = q.lower().strip()

    if not query_lower:
        results = list(pool)
    else:
        results = []
        for srv in pool:
            searchable = f"{srv['name']} {srv['title']} {srv['description']} {' '.join(srv.get('keywords', []))}".lower()
            if query_lower in searchable:
                results.append(srv)

    if sort == "stars":
        results.sort(key=lambda s: (s.get("stars") is None, -(s.get("stars") or 0), s["name"]))
    else:
        results.sort(key=lambda s: s["name"])

    total = len(results)
    page = results[offset : offset + limit]

    summary = [
        {
            "name": s["name"],
            "title": s["title"],
            "description": s["description"],
            "version": s["version"],
            "remoteUrl": s["remoteUrl"],
            "remoteType": s["remoteType"],
            "repositoryUrl": s["repositoryUrl"],
            "websiteUrl": s["websiteUrl"],
            "iconUrl": s.get("iconUrl", ""),
            "stars": s.get("stars"),
            "source": s.get("source", "community"),
        }
        for s in page
    ]

    return {"servers": summary, "total": total, "offset": offset, "limit": limit}


@mcp_registry.router.get("/detail/{server_name:path}")
async def registry_detail(server_name: str):
    srv = _cache.get(server_name)
    if not srv:
        return {"error": "Server not found"}, 404
    return {"server": srv}
