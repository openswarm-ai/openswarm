import asyncio
import logging
import os
import re
import time
from contextlib import asynccontextmanager
from typing import Optional

import httpx
from fastapi import Query
from backend.config.Apps import SubApp

logger = logging.getLogger(__name__)

REGISTRY_BASE = "https://registry.modelcontextprotocol.io/v0.1"
PAGE_LIMIT = 100
REFRESH_INTERVAL_S = 3600

GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN", "")
GITHUB_BATCH = 4000 if GITHUB_TOKEN else 50
GITHUB_CONCURRENT = 10

_cache: dict[str, dict] = {}
_cache_updated_at: float = 0
_refresh_task: Optional[asyncio.Task] = None
_stars_cache: dict[str, int] = {}


def _extract_gh_repo(repo_url: str) -> Optional[str]:
    """Parse 'owner/repo' from a GitHub URL."""
    if not repo_url or "github.com" not in repo_url:
        return None
    parts = repo_url.rstrip("/").split("/")
    try:
        idx = next(i for i, p in enumerate(parts) if "github.com" in p)
        if len(parts) > idx + 2:
            owner = parts[idx + 1]
            repo = parts[idx + 2].removesuffix(".git")
            return f"{owner}/{repo}"
    except StopIteration:
        pass
    return None


def _extract_server(entry: dict) -> Optional[dict]:
    """Extract a flat server record from a registry entry, keeping only latest versions."""
    meta = entry.get("_meta", {}).get("io.modelcontextprotocol.registry/official", {})
    if not meta.get("isLatest"):
        return None

    srv = entry.get("server", {})
    name = srv.get("name", "")
    if not name:
        return None

    remotes = srv.get("remotes", [])
    remote_url = ""
    remote_type = ""
    if remotes:
        remote_url = remotes[0].get("url", "")
        remote_type = remotes[0].get("type", "")

    repo = srv.get("repository", {})

    packages = srv.get("packages", [])
    env_vars = []
    if packages:
        env_vars = packages[0].get("environmentVariables", [])

    pub_meta = srv.get("_meta", {}).get("io.modelcontextprotocol.registry/publisher-provided", {})

    icons = srv.get("icons", [])
    icon_url = icons[0]["src"] if icons else ""
    repo_url = repo.get("url", "") if isinstance(repo, dict) else ""
    if not icon_url and repo_url and "github.com" in repo_url:
        parts = repo_url.rstrip("/").split("/")
        gh_idx = next((i for i, p in enumerate(parts) if "github.com" in p), -1)
        if gh_idx >= 0 and len(parts) > gh_idx + 1:
            icon_url = f"https://github.com/{parts[gh_idx + 1]}.png?size=64"

    return {
        "name": name,
        "title": srv.get("title", ""),
        "description": srv.get("description", ""),
        "version": srv.get("version", ""),
        "websiteUrl": srv.get("websiteUrl", ""),
        "repositoryUrl": repo_url,
        "remoteUrl": remote_url,
        "remoteType": remote_type,
        "iconUrl": icon_url,
        "environmentVariables": env_vars,
        "keywords": pub_meta.get("keywords", []),
        "license": pub_meta.get("license", ""),
        "stars": None,
        "source": "community",
    }


async def _fetch_all_servers() -> dict[str, dict]:
    """Paginate through the full registry and return a dict keyed by server name."""
    servers: dict[str, dict] = {}
    cursor: Optional[str] = None
    pages = 0

    async with httpx.AsyncClient(timeout=30.0) as client:
        while True:
            params: dict = {"limit": PAGE_LIMIT}
            if cursor:
                params["cursor"] = cursor

            try:
                resp = await client.get(f"{REGISTRY_BASE}/servers", params=params)
                resp.raise_for_status()
                data = resp.json()
            except Exception as e:
                logger.warning(f"MCP registry fetch failed on page {pages}: {e}")
                break

            entries = data.get("servers", [])
            if not entries:
                break

            for entry in entries:
                record = _extract_server(entry)
                if record:
                    servers[record["name"]] = record

            pages += 1
            next_cursor = data.get("metadata", {}).get("nextCursor")
            if not next_cursor:
                break
            cursor = next_cursor

    logger.info(f"MCP registry cache refreshed: {len(servers)} servers from {pages} pages")
    return servers


GOOGLE_README_URL = "https://raw.githubusercontent.com/google/mcp/main/README.md"
GOOGLE_ICON_URL = "https://github.com/google.png?size=64"
_ENTRY_RE = re.compile(r"\[\*\*(.+?)\*\*\]\((.+?)\)(?:[,\s]*(.+))?")


def _slugify(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def _parse_google_readme(text: str) -> dict[str, dict]:
    servers: dict[str, dict] = {}
    section: Optional[str] = None

    for line in text.splitlines():
        stripped = line.strip()
        if "remote mcp servers" in stripped.lower() and stripped.startswith("#"):
            section = "remote"
            continue
        if "open-source mcp servers" in stripped.lower() and stripped.startswith("#"):
            section = "open-source"
            continue
        if stripped.startswith("#") and section is not None:
            # Hit a new top-level section (e.g. Examples, Resources), stop parsing
            if not stripped.lower().startswith("### **"):
                section = None
            continue
        if section is None:
            continue

        m = _ENTRY_RE.search(stripped)
        if not m:
            continue

        title = m.group(1).strip()
        url = m.group(2).strip()
        desc_raw = (m.group(3) or "").strip().rstrip(".")

        slug = _slugify(title)
        key = f"google/{slug}"

        is_github = "github.com" in url or "go.dev" in url
        repo_url = url if is_github else ""
        website_url = url if not is_github else ""

        if section == "remote":
            remote_type = "google-cloud-remote"
            description = desc_raw or f"Google Cloud managed MCP server for {title}"
        else:
            remote_type = "open-source"
            description = desc_raw or f"Google open-source MCP server for {title}"

        servers[key] = {
            "name": key,
            "title": title,
            "description": description,
            "version": "",
            "websiteUrl": website_url,
            "repositoryUrl": repo_url,
            "remoteUrl": "",
            "remoteType": remote_type,
            "iconUrl": GOOGLE_ICON_URL,
            "environmentVariables": [],
            "keywords": ["google", section],
            "license": "Apache-2.0",
            "stars": None,
            "source": "google",
        }

    return servers


async def _fetch_google_servers() -> dict[str, dict]:
    """Fetch and parse Google's MCP server catalog from their GitHub README."""
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(GOOGLE_README_URL)
            resp.raise_for_status()
            servers = _parse_google_readme(resp.text)
            logger.info(f"Google MCP catalog: parsed {len(servers)} servers")
            return servers
    except Exception as e:
        logger.warning(f"Google MCP catalog fetch failed: {e}")
        return {}


async def _fetch_github_stars(servers: dict[str, dict]):
    """Batch-fetch GitHub star counts for servers with GitHub repos.

    Uses an in-memory cache so stars accumulate across refresh cycles even
    when rate-limited (60 req/hr unauthenticated, 5 000 with GITHUB_TOKEN).
    """
    global _stars_cache

    needed: list[str] = []
    for srv in servers.values():
        gh = _extract_gh_repo(srv.get("repositoryUrl", ""))
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
        gh = _extract_gh_repo(srv.get("repositoryUrl", ""))
        srv["stars"] = _stars_cache.get(gh) if gh else None


async def _refresh_loop():
    """Background loop that refreshes the cache on startup and then hourly."""
    global _cache, _cache_updated_at
    while True:
        try:
            community, google = await asyncio.gather(
                _fetch_all_servers(),
                _fetch_google_servers(),
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
