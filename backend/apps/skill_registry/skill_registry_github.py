import os
import re

import httpx

GH_API = "https://api.github.com"
MAX_SKILL_FILES = 60
SCRIPT_EXTS = (".sh", ".py", ".js", ".mjs", ".cjs", ".ts", ".rb", ".pl", ".ps1", ".bat", ".php")


class RegistryRateLimited(Exception):
    """GitHub's unauthenticated API (60/hr) is exhausted; the caller surfaces a
    'try again shortly' rather than a generic failure."""


def parse_frontmatter(raw: str) -> tuple[dict, str]:
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


def is_script_path(rel: str) -> bool:
    """Whether a skill file is executable code worth disclosing before install."""
    if rel.lower().endswith(SCRIPT_EXTS):
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
    return skill_md, members[:MAX_SKILL_FILES]


def tree_blob_paths(tree: list[dict]) -> list[str]:
    """The blob (file) paths from a GitHub recursive tree, ignoring tree (dir) entries."""
    return [t["path"] for t in tree if t.get("type") == "blob" and isinstance(t.get("path"), str)]


def folder_tree_sha(tree: list[dict], folder: str) -> str:
    """The git tree SHA of `folder` within a recursive tree: a per-folder fingerprint
    that changes iff something inside it changes, so one skill going stale never marks
    its siblings stale. '' when the folder isn't present as a tree entry."""
    for t in tree:
        if t.get("type") == "tree" and t.get("path") == folder:
            return t.get("sha", "") or ""
    return ""


async def tree_at(client: httpx.AsyncClient, owner: str, repo: str, branch: str):
    """(tree | None) for a branch. None on 404 (branch absent); raises on rate limit.
    GitHub signals the limit as 403 (primary) or 429 (secondary), so treat both."""
    r = await client.get(f"{GH_API}/repos/{owner}/{repo}/git/trees/{branch}?recursive=1")
    if r.status_code == 200:
        return r.json().get("tree", [])
    if r.status_code in (403, 429):
        raise RegistryRateLimited()
    return None


async def fetch_repo_tree(client: httpx.AsyncClient, owner: str, repo: str) -> tuple[str, list[dict]]:
    """Recursive tree of owner/repo. Tries main then master first (one call, the
    99% case, no quota wasted on a repo-meta lookup); only if BOTH are absent
    does it ask the repo for its real default branch (handles develop/trunk/etc).
    Raises RegistryRateLimited on a 403, ValueError if no branch resolves."""
    for branch in ("main", "master"):
        tree = await tree_at(client, owner, repo, branch)
        if tree is not None:
            return branch, tree
    meta = await client.get(f"{GH_API}/repos/{owner}/{repo}")
    if meta.status_code == 403:
        raise RegistryRateLimited()
    if meta.status_code == 200:
        default = meta.json().get("default_branch")
        if default and default not in ("main", "master"):
            tree = await tree_at(client, owner, repo, default)
            if tree is not None:
                return default, tree
    raise ValueError(f"repo {owner}/{repo} has no resolvable default branch")
