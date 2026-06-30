import asyncio
import logging
import time
from typing import Optional

import httpx

from backend.apps.skill_registry.skill_registry_github import (
    RegistryRateLimited,
    parse_frontmatter,
    is_script_path,
    github_headers,
    select_skill_paths,
    tree_blob_paths,
    folder_tree_sha,
    tree_at,
    fetch_repo_tree,
    MAX_SKILL_FILES,
)

logger = logging.getLogger(__name__)

REPO = "anthropics/skills"
BRANCH = "main"
RAW_BASE = f"https://raw.githubusercontent.com/{REPO}/{BRANCH}"
MANIFEST_URL = f"{RAW_BASE}/.claude-plugin/marketplace.json"
CONCURRENT_FETCHES = 15
GH_RAW = "https://raw.githubusercontent.com"
COMMUNITY_SEARCH_URL = "https://skills.sh/api/search"
P_COMMUNITY_TREE_TTL = 600

# The curated repo's recursive file tree, warmed hourly alongside the catalog. A curated install reads paths from here and fetches contents over raw, so it makes ZERO GitHub API calls in the normal case (the trees API is the 60/hr-limited part); update detection reads per-folder tree SHAs from it too. Empty until the first refresh warms it; install falls back to one live tree call then.
curated_tree: list[dict] = []
# Community repo trees for update detection, cached briefly (best-effort) so an updates check on skills.sh-installed skills doesn't refetch every page load nor burn the API.
p_community_tree_cache: dict[str, tuple] = {}


async def p_fetch_skill_paths(client: httpx.AsyncClient) -> list[tuple[str, str]]:
    """Fetch the marketplace.json manifest and return (skill_folder, plugin_name) pairs.

    Uses raw.githubusercontent.com; no GitHub API needed, no rate limiting.
    """
    resp = await client.get(MANIFEST_URL)
    resp.raise_for_status()
    manifest = resp.json()

    paths: list[tuple[str, str]] = []
    for plugin in manifest.get("plugins", []):
        plugin_name = plugin.get("name", "")
        for skill_ref in plugin.get("skills", []):
            folder = skill_ref.lstrip("./")
            paths.append((folder, plugin_name))
    return paths


async def p_fetch_one_skill(
    client: httpx.AsyncClient,
    sem: asyncio.Semaphore,
    folder: str,
    plugin_name: str,
) -> Optional[dict]:
    async with sem:
        try:
            resp = await client.get(f"{RAW_BASE}/{folder}/SKILL.md")
            if resp.status_code != 200:
                return None
            raw = resp.text
        except Exception as exc:
            logger.debug(f"Failed to fetch {folder}/SKILL.md: {exc}")
            return None

    meta, body = parse_frontmatter(raw)
    name = meta.get("name", "")
    if not name:
        folder_name = folder.rsplit("/", 1)[-1]
        name = folder_name.replace("-", " ").replace("_", " ").title()

    return {
        "name": name,
        "description": meta.get("description", ""),
        "content": body,
        "folder": folder,
        "category": plugin_name.replace("-", " ").replace("_", " ").title(),
        "repositoryUrl": f"https://github.com/{REPO}/tree/{BRANCH}/{folder}",
    }


async def fetch_all_skills() -> dict[str, dict]:
    skills: dict[str, dict] = {}
    async with httpx.AsyncClient(timeout=30.0) as client:
        try:
            paths = await p_fetch_skill_paths(client)
        except Exception as e:
            logger.warning(f"Skill registry manifest fetch failed: {e}")
            return skills

        logger.info(f"Skill registry: found {len(paths)} skills in manifest, fetching content...")
        sem = asyncio.Semaphore(CONCURRENT_FETCHES)
        results = await asyncio.gather(
            *[p_fetch_one_skill(client, sem, folder, plugin) for folder, plugin in paths]
        )
        for rec in results:
            if rec:
                skills[rec["name"]] = rec

    logger.info(f"Skill registry cache refreshed: {len(skills)} skills")
    return skills


async def warm_curated_tree() -> None:
    """Best-effort: list the anthropics/skills repo once and cache its file paths so
    curated installs need ZERO trees-API calls (they read paths here, fetch contents
    over raw). One cheap call per hourly refresh, reused by every install in that hour.
    Isolated, a failure here never touches the SKILL.md catalog; install falls back to
    a live tree call while the cache is cold."""
    global curated_tree
    owner, _, repo = REPO.partition("/")
    try:
        async with httpx.AsyncClient(timeout=30.0, headers=github_headers()) as client:
            tree = await tree_at(client, owner, repo, BRANCH)
        if tree:
            curated_tree = tree
            logger.info(f"Curated skill tree warmed: {len(tree_blob_paths(tree))} file paths cached")
    except RegistryRateLimited:
        # Visible on purpose: a rate-limited warm-up means installs stay on the slow live-call path until the IP's quota resets or a token is set.
        logger.warning("Curated tree warm-up rate-limited by GitHub (60/hr anon limit). Set GITHUB_TOKEN or wait for the hourly reset; installs use a live tree call meanwhile.")
    except Exception:
        logger.debug("curated tree warm-up failed; installs fall back to a live tree call", exc_info=True)


async def p_build_resolved_skill(
    client: httpx.AsyncClient,
    owner: str,
    repo: str,
    branch: str,
    skill_dir: str,
    members: list[str],
    skill_id: str,
    version: str,
) -> dict:
    """Fetch every member file of a resolved skill folder and assemble the install
    payload (relpaths, scripts list, secret scan, provenance). Shared by the community
    and curated resolvers so both install the WHOLE folder identically. Fetches text
    only; never runs anything. `version` is the folder's tree SHA, the update fingerprint."""
    prefix = (skill_dir + "/") if skill_dir else ""
    files: dict[str, str] = {}
    for p in members:
        rel = p[len(prefix):] if prefix else p
        raw = await client.get(f"{GH_RAW}/{owner}/{repo}/{branch}/{p}")
        if raw.status_code == 200:
            files[rel] = raw.text
    if "SKILL.md" not in files:
        raise ValueError("SKILL.md could not be fetched")

    meta, _ = parse_frontmatter(files["SKILL.md"])
    # Reuse the .swarm importer's content scan: flag files holding secret-shaped literals (the author's leaked key, or a sketchy skill) so the user sees it before installing from an unvetted repo.
    from backend.common.secret_scan import find_secrets_in_files
    secret_findings = find_secrets_in_files({rel: data.encode("utf-8", "ignore") for rel, data in files.items()})
    return {
        "name": meta.get("name") or skill_id,
        "description": meta.get("description", ""),
        "repo_url": f"https://github.com/{owner}/{repo}/tree/{branch}/{skill_dir}".rstrip("/"),
        "skill_id": skill_id,
        "files": files,
        "scripts": sorted(rel for rel in files if is_script_path(rel)),
        "secret_findings": secret_findings,
        "source": f"{owner}/{repo}",
        "folder": skill_dir,
        "version": version,
    }


async def resolve_community_skill(source: str, skill_id: str) -> dict:
    """Resolve a skills.sh entry (source='owner/repo', skill_id=folder name) to
    its files via the GitHub trees API. Returns name/description/repo_url plus
    {relpath: content} and the list of script files. Fetches text only; never
    runs anything. Raises ValueError on a bad source or a missing skill, and
    RegistryRateLimited when GitHub's anon API is exhausted."""
    owner, _, repo = source.partition("/")
    if not owner or not repo:
        raise ValueError(f"unrecognized source '{source}' (expected owner/repo)")
    async with httpx.AsyncClient(timeout=30.0, headers=github_headers()) as client:
        branch, tree = await fetch_repo_tree(client, owner, repo)
        skill_md, members = select_skill_paths(tree, skill_id)
        skill_dir = skill_md[: -len("/SKILL.md")] if "/" in skill_md else ""
        version = folder_tree_sha(tree, skill_dir)
        return await p_build_resolved_skill(client, owner, repo, branch, skill_dir, members, skill_id, version)


async def resolve_curated_skill(folder: str) -> dict:
    """Resolve a curated (anthropics/skills) skill folder to ALL its files via the
    GitHub trees API, so multi-file curated skills (pdf/docx/pptx scripts, etc.)
    install whole instead of just their SKILL.md. The exact folder comes from our
    catalog, so we match it precisely (not by basename). Same payload shape as
    resolve_community_skill. Raises ValueError if the folder has no SKILL.md and
    RegistryRateLimited when GitHub's anon API is exhausted."""
    owner, _, repo = REPO.partition("/")
    skill_dir = folder.rstrip("/")
    skill_id = skill_dir.rsplit("/", 1)[-1]
    prefix = skill_dir + "/"
    async with httpx.AsyncClient(timeout=30.0, headers=github_headers()) as client:
        tree = curated_tree
        if not tree:
            # Cold cache (pre-first-refresh, or a failed/rate-limited warm-up): pay one live tree call this once.
            tree = await tree_at(client, owner, repo, BRANCH)
            if tree is None:
                raise ValueError(f"could not read {REPO}@{BRANCH} tree")
        blobs = tree_blob_paths(tree)
        if (prefix + "SKILL.md") not in blobs:
            raise ValueError(f"no SKILL.md at '{folder}'")
        members = [p for p in blobs if p.startswith(prefix)][:MAX_SKILL_FILES]
        version = folder_tree_sha(tree, skill_dir)
        return await p_build_resolved_skill(client, owner, repo, BRANCH, skill_dir, members, skill_id, version)


def search_curated(cache: dict[str, dict], q: str, category: str, offset: int, limit: int) -> dict:
    """Filter + paginate the in-memory curated catalog. Pure (cache passed in) so the
    route stays a thin wrapper and this layer owns all skill-data shaping."""
    pool = list(cache.values())
    if category:
        cat_lower = category.lower()
        pool = [s for s in pool if s.get("category", "").lower() == cat_lower]

    query_lower = q.lower().strip()
    if query_lower:
        pool = [sk for sk in pool if query_lower in f"{sk['name']} {sk['description']} {sk.get('category', '')}".lower()]

    pool.sort(key=lambda s: s["name"].lower())
    total = len(pool)
    page = pool[offset: offset + limit]
    summary = [
        {
            "name": s["name"],
            "description": s["description"],
            "folder": s["folder"],
            "category": s.get("category", "General"),
            "repositoryUrl": s.get("repositoryUrl", ""),
        }
        for s in page
    ]
    return {"skills": summary, "total": total, "offset": offset, "limit": limit}


async def community_search(q: str, limit: int) -> dict:
    """Live-proxy a query to the skills.sh wild registry. Not cached: it's a
    600k-entry remote index, so we search it on demand rather than mirror it."""
    async with httpx.AsyncClient(timeout=15.0, headers={"User-Agent": "openswarm"}) as client:
        r = await client.get(COMMUNITY_SEARCH_URL, params={"q": q or "skill"})
        r.raise_for_status()
        data = r.json()
    skills = []
    for s in (data.get("skills") or [])[:limit]:
        src = s.get("source", "")
        try:
            installs = int(s.get("installs") or 0)
        except (TypeError, ValueError):
            installs = 0
        skills.append({
            "name": s.get("name", ""),
            "description": f"{installs:,} installs",
            "folder": s.get("skillId", ""),
            "category": src,
            "repositoryUrl": f"https://github.com/{src}" if src else "",
            "source": src,
            "skillId": s.get("skillId", ""),
            "installs": installs,
            "community": True,
        })
    return {"skills": skills, "total": len(skills), "offset": 0, "limit": limit, "source": "community"}


async def safe_repo_tree(source: str):
    """Recursive tree for a community 'owner/repo', cached briefly and best-effort
    (None on rate-limit / missing repo) so an updates check never fails the whole
    list because one repo is unreachable."""
    now = time.time()
    hit = p_community_tree_cache.get(source)
    if hit and now - hit[0] < P_COMMUNITY_TREE_TTL:
        return hit[1]
    owner, _, repo = source.partition("/")
    tree = None
    if owner and repo:
        try:
            async with httpx.AsyncClient(timeout=30.0, headers=github_headers()) as client:
                _, tree = await fetch_repo_tree(client, owner, repo)
        except Exception:
            tree = None
    p_community_tree_cache[source] = (now, tree)
    return tree
