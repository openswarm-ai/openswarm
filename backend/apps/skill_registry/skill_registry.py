import asyncio
import json
import logging
import os
import re
import time
from contextlib import asynccontextmanager
from typing import Optional

import httpx
from fastapi import HTTPException, Query
from pydantic import BaseModel
from backend.config.Apps import SubApp

logger = logging.getLogger(__name__)

REPO = "anthropics/skills"
BRANCH = "main"
RAW_BASE = f"https://raw.githubusercontent.com/{REPO}/{BRANCH}"
MANIFEST_URL = f"{RAW_BASE}/.claude-plugin/marketplace.json"
REFRESH_INTERVAL_S = 3600
CONCURRENT_FETCHES = 15
# Retry the startup fetch on this short backoff (capped) until the FIRST success, instead of waiting a full REFRESH_INTERVAL_S after a cold/slow/failed fetch. That 1h gap was the "skills empty until reboot" bug on cold Windows networks.
P_RETRY_BACKOFF_START_S = 2
P_RETRY_BACKOFF_MAX_S = 60

# Catalog ships in the repo so a brand-new install shows skills with zero network (build snapshot), and every successful live fetch is persisted to the user's cache so subsequent launches are instant + offline-safe. The live fetch always overwrites both once it lands, so neither can go stale at runtime.
BUNDLED_SNAPSHOT = os.path.join(os.path.dirname(__file__), "skills_snapshot.json")

p_cache: dict[str, dict] = {}
p_cache_updated_at: float = 0
p_refresh_task: Optional[asyncio.Task] = None

# The curated repo's recursive file tree, warmed hourly alongside the catalog. A curated install reads paths from here and fetches contents over raw, so it makes ZERO GitHub API calls in the normal case (the trees API is the 60/hr-limited part); update detection reads per-folder tree SHAs from it too. Empty until the first refresh warms it; install falls back to one live tree call then.
p_curated_tree: list[dict] = []
# Community repo trees for update detection, cached briefly (best-effort) so an updates check on skills.sh-installed skills doesn't refetch every page load nor burn the API.
P_COMMUNITY_TREE_TTL = 600
p_community_tree_cache: dict[str, tuple] = {}


def disk_cache_path() -> str:
    base = os.environ.get("OPENSWARM_SKILL_CACHE_DIR") or os.path.expanduser(
        "~/.openswarm/cache"
    )
    return os.path.join(base, "skill_registry.json")


def load_seed_cache() -> dict[str, dict]:
    """Return a non-empty catalog from the on-disk last-good cache, falling back
    to the bundled snapshot, so the registry is never empty on a cold/offline
    start. Returns {} only if neither source is present/valid."""
    for path in (disk_cache_path(), BUNDLED_SNAPSHOT):
        try:
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict) and data:
                logger.info(f"Skill registry: seeded {len(data)} skills from {os.path.basename(path)}")
                return data
        except (OSError, ValueError):
            continue
    return {}


def save_disk_cache(skills: dict[str, dict]) -> None:
    """Persist the last good live fetch so the next launch is instant. Atomic
    replace so a crash mid-write can't leave a truncated cache."""
    if not skills:
        return
    path = disk_cache_path()
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = f"{path}.tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(skills, f)
        os.replace(tmp, path)
    except OSError:
        logger.debug("Skill registry: could not persist disk cache", exc_info=True)


def p_parse_frontmatter(raw: str) -> tuple[dict, str]:
    """Split YAML frontmatter from markdown body."""
    if not raw.startswith("---"):
        return {}, raw
    end = raw.find("---", 3)
    if end == -1:
        return {}, raw
    fm_block = raw[3:end].strip()
    body = raw[end + 3:].strip()
    meta: dict = {}
    for line in fm_block.splitlines():
        m = re.match(r"^(\w[\w_-]*)\s*:\s*(.+)$", line)
        if m:
            meta[m.group(1).strip()] = m.group(2).strip().strip('"').strip("'")
    return meta, body


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

    meta, body = p_parse_frontmatter(raw)
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


async def p_fetch_all_skills() -> dict[str, dict]:
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


async def p_warm_curated_tree() -> None:
    """Best-effort: list the anthropics/skills repo once and cache its file paths so
    curated installs need ZERO trees-API calls (they read paths here, fetch contents
    over raw). One cheap call per hourly refresh, reused by every install in that hour.
    Isolated, a failure here never touches the SKILL.md catalog; install falls back to
    a live tree call while the cache is cold."""
    global p_curated_tree
    owner, _, repo = REPO.partition("/")
    try:
        async with httpx.AsyncClient(timeout=30.0, headers=github_headers()) as client:
            tree = await p_tree_at(client, owner, repo, BRANCH)
        if tree:
            p_curated_tree = tree
            logger.info(f"Curated skill tree warmed: {len(p_tree_blob_paths(tree))} file paths cached")
    except RegistryRateLimited:
        # Visible on purpose: a rate-limited warm-up means installs stay on the slow live-call path until the IP's quota resets or a token is set.
        logger.warning("Curated tree warm-up rate-limited by GitHub (60/hr anon limit). Set GITHUB_TOKEN or wait for the hourly reset; installs use a live tree call meanwhile.")
    except Exception:
        logger.debug("curated tree warm-up failed; installs fall back to a live tree call", exc_info=True)


async def p_refresh_loop():
    global p_cache, p_cache_updated_at
    backoff = P_RETRY_BACKOFF_START_S
    while True:
        ok = False
        try:
            fetched = await p_fetch_all_skills()
            if fetched:
                p_cache = fetched
                p_cache_updated_at = time.time()
                save_disk_cache(p_cache)
                ok = True
        except Exception as e:
            logger.exception(f"Skill registry refresh error: {e}")
        if ok:
            # Warm the curated file-tree on the SLOW path only (never on the fast failure-retry below, which would burn the 60/hr quota in seconds).
            await p_warm_curated_tree()
            # Settle to the slow hourly refresh once we have a good catalog.
            backoff = P_RETRY_BACKOFF_START_S
            await asyncio.sleep(REFRESH_INTERVAL_S)
        else:
            # Cold/slow/failed fetch: retry soon (capped) until the first success so a transient network hiccup doesn't leave the catalog empty for an hour. The seeded snapshot keeps it non-empty meanwhile.
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, P_RETRY_BACKOFF_MAX_S)


@asynccontextmanager
async def skill_registry_lifespan():
    global p_refresh_task, p_cache
    # Seed instantly from disk/bundled snapshot so the very first request never sees an empty catalog (the live fetch below overwrites it when it lands).
    if not p_cache:
        p_cache = load_seed_cache()
    p_refresh_task = asyncio.create_task(p_refresh_loop())
    yield
    if p_refresh_task:
        p_refresh_task.cancel()
        try:
            await p_refresh_task
        except asyncio.CancelledError:
            pass


skill_registry = SubApp("skill-registry", skill_registry_lifespan)


@skill_registry.router.get("/stats")
async def registry_stats():
    categories: dict[str, int] = {}
    for s in p_cache.values():
        cat = s.get("category", "General")
        categories[cat] = categories.get(cat, 0) + 1
    return {
        "total": len(p_cache),
        "categories": categories,
        "lastUpdated": p_cache_updated_at,
    }


@skill_registry.router.get("/search")
async def registry_search(
    q: str = Query("", description="Search query"),
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
    sort: str = Query("name", description="Sort by: name"),
    category: str = Query("", description="Filter by category"),
    source: str = Query("curated", description="curated (vetted) | community (skills.sh wild registry)"),
):
    # The wild registry is a remote 600k-entry index, searched live, not mirrored.
    if source == "community":
        try:
            return await p_community_search(q, limit)
        except Exception as e:
            logger.warning(f"community skill search failed: {e}")
            return {"skills": [], "total": 0, "offset": 0, "limit": limit, "source": "community", "error": "skills.sh unreachable"}

    pool = list(p_cache.values())
    if category:
        cat_lower = category.lower()
        pool = [s for s in pool if s.get("category", "").lower() == cat_lower]

    query_lower = q.lower().strip()
    if query_lower:
        filtered = []
        for sk in pool:
            searchable = f"{sk['name']} {sk['description']} {sk.get('category', '')}".lower()
            if query_lower in searchable:
                filtered.append(sk)
        pool = filtered

    pool.sort(key=lambda s: s["name"].lower())
    total = len(pool)
    page = pool[offset : offset + limit]

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


@skill_registry.router.get("/detail/{skill_name:path}")
async def registry_detail(skill_name: str):
    sk = p_cache.get(skill_name)
    if not sk:
        return {"error": "Skill not found"}, 404
    return {"skill": sk}


# --------------------------------------------------------------------------- Community source: the skills.sh wild registry (~600k+ telemetry-ranked, zero-curation community skills, GitHub-repo backed). The curated source above (anthropics/skills) stays the default; community is opt-in via ?source=community and the UI flags it as unvetted. See .claude/SECURITY.md for the posture: this installs INERT files only (never executes), discloses scripts before commit, and any skill script later runs through the same gated Bash path as anything. ---------------------------------------------------------------------------

P_COMMUNITY_SEARCH_URL = "https://skills.sh/api/search"
P_GH_API = "https://api.github.com"
P_GH_RAW = "https://raw.githubusercontent.com"
P_MAX_SKILL_FILES = 60
P_SCRIPT_EXTS = (".sh", ".py", ".js", ".mjs", ".cjs", ".ts", ".rb", ".pl", ".ps1", ".bat", ".php")


def is_script_path(rel: str) -> bool:
    """Whether a skill file is executable code worth disclosing before install."""
    if rel.lower().endswith(P_SCRIPT_EXTS):
        return True
    head = rel.split("/", 1)[0].lower()
    return head in ("scripts", "bin", "hooks")


def github_headers() -> dict:
    """GitHub request headers, with auth if a token is set. Unauthenticated is
    60 req/hr/IP (fine for the odd install, the wall for a power user); a token
    (OPENSWARM_GITHUB_TOKEN or GITHUB_TOKEN) raises it to 5000/hr."""
    headers = {"User-Agent": "openswarm-skill-registry", "Accept": "application/vnd.github+json"}
    token = os.environ.get("OPENSWARM_GITHUB_TOKEN") or os.environ.get("GITHUB_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def select_skill_paths(tree: list[dict], skill_id: str) -> tuple[str, list[str]]:
    """From a GitHub recursive tree, pick the SKILL.md for `skill_id` and every
    file beside it. Pure, so the resolution logic is unit-tested without a network
    round-trip. When a repo has several `<x>/<skill_id>/SKILL.md` matches the pick
    is deterministic: prefer a top-level `<skill_id>/`, then `skills/<skill_id>/`,
    then the shallowest, then alphabetical, never an arbitrary tie."""
    blobs = [t["path"] for t in tree if t.get("type") == "blob" and isinstance(t.get("path"), str)]
    candidates = [p for p in blobs if p.endswith(f"/{skill_id}/SKILL.md") or p == f"{skill_id}/SKILL.md"]
    if not candidates:
        raise ValueError(f"no SKILL.md for '{skill_id}' in this repo")

    def p_rank(p: str) -> tuple:
        if p == f"{skill_id}/SKILL.md":
            return (0, 0, p)
        if p == f"skills/{skill_id}/SKILL.md":
            return (1, p.count("/"), p)
        return (2, p.count("/"), p)

    skill_md = min(candidates, key=p_rank)
    skill_dir = skill_md[: -len("/SKILL.md")] if "/" in skill_md else ""
    prefix = (skill_dir + "/") if skill_dir else ""
    members = [p for p in blobs if (p.startswith(prefix) if prefix else "/" not in p)]
    return skill_md, members[:P_MAX_SKILL_FILES]


class RegistryRateLimited(Exception):
    """GitHub's unauthenticated API (60/hr) is exhausted; the caller surfaces a
    'try again shortly' rather than a generic failure."""


def p_tree_blob_paths(tree: list[dict]) -> list[str]:
    """The blob (file) paths from a GitHub recursive tree, ignoring tree (dir) entries."""
    return [t["path"] for t in tree if t.get("type") == "blob" and isinstance(t.get("path"), str)]


def p_folder_tree_sha(tree: list[dict], folder: str) -> str:
    """The git tree SHA of `folder` within a recursive tree: a per-folder fingerprint
    that changes iff something inside it changes, so one skill going stale never marks
    its siblings stale. '' when the folder isn't present as a tree entry."""
    for t in tree:
        if t.get("type") == "tree" and t.get("path") == folder:
            return t.get("sha", "") or ""
    return ""


async def p_tree_at(client: httpx.AsyncClient, owner: str, repo: str, branch: str):
    """(tree | None) for a branch. None on 404 (branch absent); raises on rate limit.
    GitHub signals the limit as 403 (primary) or 429 (secondary), so treat both."""
    r = await client.get(f"{P_GH_API}/repos/{owner}/{repo}/git/trees/{branch}?recursive=1")
    if r.status_code == 200:
        return r.json().get("tree", [])
    if r.status_code in (403, 429):
        raise RegistryRateLimited()
    return None


async def p_fetch_repo_tree(client: httpx.AsyncClient, owner: str, repo: str) -> tuple[str, list[dict]]:
    """Recursive tree of owner/repo. Tries main then master first (one call, the
    99% case, no quota wasted on a repo-meta lookup); only if BOTH are absent
    does it ask the repo for its real default branch (handles develop/trunk/etc).
    Raises RegistryRateLimited on a 403, ValueError if no branch resolves."""
    for branch in ("main", "master"):
        tree = await p_tree_at(client, owner, repo, branch)
        if tree is not None:
            return branch, tree
    meta = await client.get(f"{P_GH_API}/repos/{owner}/{repo}")
    if meta.status_code == 403:
        raise RegistryRateLimited()
    if meta.status_code == 200:
        default = meta.json().get("default_branch")
        if default and default not in ("main", "master"):
            tree = await p_tree_at(client, owner, repo, default)
            if tree is not None:
                return default, tree
    raise ValueError(f"repo {owner}/{repo} has no resolvable default branch")


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
        raw = await client.get(f"{P_GH_RAW}/{owner}/{repo}/{branch}/{p}")
        if raw.status_code == 200:
            files[rel] = raw.text
    if "SKILL.md" not in files:
        raise ValueError("SKILL.md could not be fetched")

    meta, _ = p_parse_frontmatter(files["SKILL.md"])
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
        branch, tree = await p_fetch_repo_tree(client, owner, repo)
        skill_md, members = select_skill_paths(tree, skill_id)
        skill_dir = skill_md[: -len("/SKILL.md")] if "/" in skill_md else ""
        version = p_folder_tree_sha(tree, skill_dir)
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
        tree = p_curated_tree
        if not tree:
            # Cold cache (pre-first-refresh, or a failed/rate-limited warm-up): pay one live tree call this once.
            tree = await p_tree_at(client, owner, repo, BRANCH)
            if tree is None:
                raise ValueError(f"could not read {REPO}@{BRANCH} tree")
        blobs = p_tree_blob_paths(tree)
        if (prefix + "SKILL.md") not in blobs:
            raise ValueError(f"no SKILL.md at '{folder}'")
        members = [p for p in blobs if p.startswith(prefix)][:P_MAX_SKILL_FILES]
        version = p_folder_tree_sha(tree, skill_dir)
        return await p_build_resolved_skill(client, owner, repo, BRANCH, skill_dir, members, skill_id, version)


async def p_community_search(q: str, limit: int) -> dict:
    """Live-proxy a query to the skills.sh wild registry. Not cached: it's a
    600k-entry remote index, so we search it on demand rather than mirror it."""
    async with httpx.AsyncClient(timeout=15.0, headers={"User-Agent": "openswarm"}) as client:
        r = await client.get(P_COMMUNITY_SEARCH_URL, params={"q": q or "skill"})
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


class p_InstallRequest(BaseModel):
    source: str
    skill_id: str
    confirm: bool = False


@skill_registry.router.post("/install")
async def registry_install(req: p_InstallRequest):
    """Install a community (skills.sh) skill, in two honest steps.

    confirm=false (default): resolve + return a disclosure (the SKILL.md and the
    list of files, flagging scripts) WITHOUT writing anything, so the user sees
    exactly what they're about to install from an unvetted repo.
    confirm=true: write the skill folder to ~/.claude/skills/. Files only; no
    script is executed here. Curated skills install via the normal skills CRUD;
    this endpoint is the wild-registry path."""
    try:
        resolved = await resolve_community_skill(req.source, req.skill_id)
    except RegistryRateLimited:
        raise HTTPException(status_code=429, detail="GitHub rate limit hit fetching this skill; try again in a few minutes.")
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"could not fetch skill: {e}")

    disclosure = {
        "name": resolved["name"],
        "description": resolved["description"],
        "repo_url": resolved["repo_url"],
        "skill_md": resolved["files"].get("SKILL.md", ""),
        "files": sorted(resolved["files"].keys()),
        "scripts": resolved["scripts"],
        "has_scripts": bool(resolved["scripts"]),
        "secret_findings": resolved.get("secret_findings", []),
    }
    if not req.confirm:
        return {"installed": False, "disclosure": disclosure}

    from backend.apps.skills.skills import write_folder_skill, unique_skill_slug
    # Never clobber an existing local skill that happens to share this slug; a wild-registry name collision lands as a copy instead of overwriting.
    slug = unique_skill_slug(resolved["skill_id"])
    skill = write_folder_skill(
        slug,
        resolved["files"],
        {
            "name": resolved["name"], "description": resolved["description"],
            "source": resolved.get("source", ""), "folder": resolved.get("folder", ""), "version": resolved.get("version", ""),
        },
    )
    return {"installed": True, "skill": skill.model_dump(), "disclosure": disclosure}


class p_CuratedInstallRequest(BaseModel):
    folder: str


@skill_registry.router.post("/install-curated")
async def registry_install_curated(req: p_CuratedInstallRequest):
    """Install a curated (anthropics/skills) skill with its FULL folder, not just
    SKILL.md, so scripts/assets land too (the old path wrote only SKILL.md, which
    left multi-file skills like pdf/docx with dead script references). Curated is
    the vetted source, so this is one-click; files are still written inert, never
    executed. Needs network at install time (the catalog only caches SKILL.md)."""
    try:
        resolved = await resolve_curated_skill(req.folder)
    except RegistryRateLimited:
        raise HTTPException(status_code=429, detail="GitHub rate limit hit fetching this skill; try again in a few minutes.")
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"could not fetch skill: {e}")

    from backend.apps.skills.skills import write_folder_skill, unique_skill_slug
    slug = unique_skill_slug(resolved["skill_id"])
    skill = write_folder_skill(
        slug,
        resolved["files"],
        {
            "name": resolved["name"], "description": resolved["description"],
            "source": resolved.get("source", ""), "folder": resolved.get("folder", ""), "version": resolved.get("version", ""),
        },
    )
    return {
        "installed": True,
        "skill": skill.model_dump(),
        "files": sorted(resolved["files"].keys()),
        "scripts": resolved["scripts"],
    }


async def p_safe_repo_tree(source: str):
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
                _, tree = await p_fetch_repo_tree(client, owner, repo)
        except Exception:
            tree = None
    p_community_tree_cache[source] = (now, tree)
    return tree


@skill_registry.router.get("/updates")
async def registry_updates():
    """Which installed skills have a newer version upstream. Curated skills check
    against the warmed tree (zero API calls); community skills re-fetch their repo
    tree (best-effort, deduped per repo, cached). A skill with no recorded source
    (user-created, or installed before versioning) is skipped, not reported."""
    from backend.apps.skills.skills import sync_skills
    outdated: list[str] = []
    checked: list[str] = []
    unknown: list[str] = []
    community_trees: dict[str, object] = {}
    for s in sync_skills():
        if not s.source or not s.folder or not s.version:
            continue
        if s.source == REPO:
            tree = p_curated_tree
        else:
            if s.source not in community_trees:
                community_trees[s.source] = await p_safe_repo_tree(s.source)
            tree = community_trees[s.source]
        if not tree:
            unknown.append(s.id)
            continue
        current = p_folder_tree_sha(tree, s.folder)
        checked.append(s.id)
        if current and current != s.version:
            outdated.append(s.id)
    return {"outdated": outdated, "checked": checked, "unknown": unknown}


class p_UpdateRequest(BaseModel):
    skill_id: str


@skill_registry.router.post("/update")
async def registry_update(req: p_UpdateRequest):
    """Re-fetch an installed skill from its recorded source and overwrite it in place,
    bumping its version. Re-runs the secret scan and returns any findings so the UI can
    flag a community update that newly ships secrets. A skill with no source (user-made)
    can't be updated."""
    from backend.apps.skills.skills import sync_skills, write_folder_skill, clear_skill_dir
    target = next((s for s in sync_skills() if s.id == req.skill_id), None)
    if target is None:
        raise HTTPException(status_code=404, detail="skill not found")
    if not target.source or not target.folder:
        raise HTTPException(status_code=400, detail="this skill has no upstream source to update from")
    try:
        if target.source == REPO:
            resolved = await resolve_curated_skill(target.folder)
        else:
            resolved = await resolve_community_skill(target.source, target.folder.rsplit("/", 1)[-1])
    except RegistryRateLimited:
        raise HTTPException(status_code=429, detail="GitHub rate limit hit; try again in a few minutes.")
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"could not fetch skill: {e}")

    # Overwrite in place: clear first so files removed upstream don't linger, keep the user's command alias, refresh everything else from source.
    clear_skill_dir(target.id)
    skill = write_folder_skill(
        target.id,
        resolved["files"],
        {
            "name": resolved["name"], "description": resolved["description"], "command": target.command,
            "source": resolved.get("source", ""), "folder": resolved.get("folder", ""), "version": resolved.get("version", ""),
        },
    )
    return {
        "updated": True,
        "skill": skill.model_dump(),
        "scripts": resolved["scripts"],
        "secret_findings": resolved.get("secret_findings", []),
    }
