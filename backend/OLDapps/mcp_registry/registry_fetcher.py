"""Data-fetching and parsing logic for MCP registry servers."""

import logging
import re
from typing import Optional

import httpx

logger = logging.getLogger(__name__)

REGISTRY_BASE = "https://registry.modelcontextprotocol.io/v0.1"
PAGE_LIMIT = 100

GOOGLE_README_URL = "https://raw.githubusercontent.com/google/mcp/main/README.md"
GOOGLE_ICON_URL = "https://github.com/google.png?size=64"
_ENTRY_RE = re.compile(r"\[\*\*(.+?)\*\*\]\((.+?)\)(?:[,\s]*(.+))?")


def extract_gh_repo(repo_url: str) -> Optional[str]:
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


async def fetch_all_servers() -> dict[str, dict]:
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


async def fetch_google_servers() -> dict[str, dict]:
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
