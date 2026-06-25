import logging
import os
from typing import Optional, Tuple

from typeguard import typechecked

logger = logging.getLogger(__name__)


@typechecked
def ensure_cwd_git_repo(cwd: str, home: Optional[str] = None) -> None:
    """Idempotently make `cwd` into a git repo with a valid HEAD.

    The CLI's built-in Agent tool uses `isolation: "worktree"` to spawn
    subagents, which runs `git rev-parse HEAD` + `git worktree add`. If
    cwd isn't a git repo, or is a repo with no commits yet, that fails
    with "worktree/base-branch metadata is broken for isolation" or
    "repo doesn't have a valid HEAD yet". We silently init a minimal
    repo with one empty commit so worktree add always has something to
    anchor on.

    Safe to call on every request, does nothing if cwd is already a
    valid repo (real project, previous init, or inside a parent repo).
    """
    try:
        home = home or os.path.expanduser("~")
        cwd_abs = os.path.abspath(cwd)
        risky_roots = {
            os.path.abspath(home),
            "/",
            os.path.abspath(os.path.dirname(home)),  # e.g. /Users
        }
        if cwd_abs in risky_roots:
            return
        if not os.path.isdir(cwd):
            return

        import subprocess as sp_git
        # Case A: cwd is inside some git repo (possibly parent). Verify HEAD resolves. If the enclosing repo is broken (e.g. a stray `.git` in $HOME with no commits, which makes workspaces under ~/.openswarm/workspaces/ inherit a broken HEAD), we need to init a fresh repo AT cwd so it shadows the parent.
        inside = sp_git.run(
            ["git", "rev-parse", "--is-inside-work-tree"],
            cwd=cwd,
            stdout=sp_git.PIPE, stderr=sp_git.DEVNULL, timeout=5,
        )
        if inside.returncode == 0 and b"true" in inside.stdout:
            # Check HEAD resolves (has at least one commit).
            head = sp_git.run(
                ["git", "rev-parse", "--verify", "HEAD"],
                cwd=cwd,
                stdout=sp_git.DEVNULL, stderr=sp_git.DEVNULL, timeout=5,
            )
            if head.returncode == 0:
                return  # parent repo is healthy, leave it alone
            # Parent repo exists but HEAD is broken.
            if os.path.isdir(os.path.join(cwd, ".git")):
                # .git is directly here, commit to fix it.
                sp_git.run(
                    ["git", "-c", "user.email=openswarm@local",
                     "-c", "user.name=OpenSwarm",
                     "commit", "--allow-empty", "-q", "-m", "openswarm init"],
                    cwd=cwd,
                    stdout=sp_git.DEVNULL, stderr=sp_git.DEVNULL, timeout=10,
                )
                return
            # .git is in a parent dir (broken home-dir repo, etc.). Init our own repo at cwd so it shadows the broken parent. Fall through to Case B.

        # Case B: cwd is not a git repo at all (or parent is broken): init + empty commit here.
        sp_git.run(
            ["git", "init", "-q", "-b", "main"],
            cwd=cwd,
            stdout=sp_git.DEVNULL, stderr=sp_git.DEVNULL, timeout=10,
        )
        sp_git.run(
            ["git", "-c", "user.email=openswarm@local",
             "-c", "user.name=OpenSwarm",
             "commit", "--allow-empty", "-q", "-m", "openswarm init"],
            cwd=cwd,
            stdout=sp_git.DEVNULL, stderr=sp_git.DEVNULL, timeout=10,
        )
    except Exception as exc:
        logger.info(f"[agent-cwd] git init skipped: {exc}")


@typechecked
def detect_git_identity(cwd: str) -> Tuple[Optional[str], Optional[str]]:
    """Resolve the origin remote and current branch for `cwd`.

    Used to label sessions in the session list ("Agent on owner/repo
    @ branch") and to keep a resumed session pinned to the same project
    even after the user `cd`'s elsewhere. Returns (None, None) for
    non-git cwds, detached HEADs, repos without an origin, or any
    subprocess failure. Credentials in the URL are stripped so a
    `https://user:token@host/...` remote becomes `https://host/...`.
    """
    if not cwd or not os.path.isdir(cwd):
        return (None, None)
    try:
        import subprocess as sp
        url_proc = sp.run(
            ["git", "remote", "get-url", "origin"],
            cwd=cwd, stdout=sp.PIPE, stderr=sp.DEVNULL, timeout=3,
        )
        repo_url: Optional[str] = None
        if url_proc.returncode == 0:
            raw = url_proc.stdout.decode("utf-8", errors="replace").strip()
            if raw:
                if "://" in raw:
                    scheme, _, rest = raw.partition("://")
                    if "@" in rest:
                        rest = rest.split("@", 1)[1]
                    repo_url = f"{scheme}://{rest}"
                else:
                    repo_url = raw
        branch_proc = sp.run(
            ["git", "branch", "--show-current"],
            cwd=cwd, stdout=sp.PIPE, stderr=sp.DEVNULL, timeout=3,
        )
        branch_name: Optional[str] = None
        if branch_proc.returncode == 0:
            raw_b = branch_proc.stdout.decode("utf-8", errors="replace").strip()
            if raw_b:
                branch_name = raw_b
        return (repo_url, branch_name)
    except Exception:
        return (None, None)
