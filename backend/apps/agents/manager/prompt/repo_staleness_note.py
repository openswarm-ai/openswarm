"""Tell an agent how old the checkout it is standing in actually is (ENG-280).

An agent was asked to fix the Workflows UI, read a checkout **545 commits behind** origin/main,
diagnosed against code that had not existed for weeks, and started editing. Nothing surfaced it.
It only stopped after the user pushed back twice with "I 100% see this feature, you're hella out
of date."

Reading a stale tree is legitimate; diagnosing from a tree of UNKNOWN vintage is the bug. This
puts the vintage in context every time, so that state stops being reachable.

Deliberately offline: it compares against the refs already on disk and never fetches. A prompt
builder is not a place to block on the network, and "behind by whatever we last saw" is enough to
make an agent check before it theorises.
"""
import subprocess
from typing import List, Optional

from typeguard import typechecked

from backend.apps.agents.manager.session.workspace_git import git_available

P_TIMEOUT_S = 2.0
# Below this, a checkout is normal working drift and a note would just be noise.
MIN_BEHIND_TO_WARN = 20


@typechecked
def p_git(cwd: str, args: List[str]) -> Optional[str]:
    """Run a read-only git command, or None if anything at all goes wrong."""
    if not git_available():
        return None
    try:
        out = subprocess.run(
            ["git", *args], cwd=cwd, capture_output=True, text=True, timeout=P_TIMEOUT_S,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if out.returncode != 0:
        return None
    return out.stdout.strip()


@typechecked
def repo_staleness_note(cwd: Optional[str]) -> Optional[str]:
    """One line naming how far behind this checkout is, or None when there is nothing to say."""
    if not cwd:
        return None
    if p_git(cwd, ["rev-parse", "--is-inside-work-tree"]) != "true":
        return None
    upstream = None
    for candidate in ("@{upstream}", "origin/main", "origin/master"):
        if p_git(cwd, ["rev-parse", "--verify", "--quiet", candidate]):
            upstream = candidate
            break
    if upstream is None:
        return None
    counts = p_git(cwd, ["rev-list", "--left-right", "--count", f"HEAD...{upstream}"])
    if not counts:
        return None
    parts = counts.split()
    if len(parts) != 2 or not parts[1].isdigit():
        return None
    behind = int(parts[1])
    if behind < MIN_BEHIND_TO_WARN:
        return None
    head = p_git(cwd, ["rev-parse", "--short", "HEAD"]) or "unknown"
    when = p_git(cwd, ["log", "-1", "--format=%cs", "HEAD"]) or "unknown date"
    return (
        f"This checkout is {behind} commits behind {upstream} (HEAD {head}, {when}). "
        "It may not contain the code the user is running, so check before diagnosing from it."
    )
