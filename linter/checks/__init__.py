"""Check infrastructure: shared filter/match utilities."""

from __future__ import annotations

import fnmatch
import os
from pathlib import Path

LINTIGNORE_PREFIX = ".lintignore"


def _matches_any(text: str, patterns: list[str]) -> bool:
    return any(fnmatch.fnmatch(text, p) for p in patterns)


def is_excluded(path: Path, root: Path, excludes: list[str]) -> bool:
    rel = path.relative_to(root)
    for part in rel.parts:
        if _matches_any(part, excludes):
            return True
    return _matches_any(str(rel), excludes)


def is_excepted(rel_path: str, rule: str, exceptions: dict[str, list[str]]) -> bool:
    return _matches_any(rel_path, exceptions.get(rule, []))


def collect_lintignores(root: Path, excludes: list[str]) -> dict[Path, set[str]]:
    """Scan *root* for ``.lintignore*`` sentinel files.

    Returns ``{directory: set_of_ignored_rules}``.
    The special token ``"__all__"`` means every rule is ignored.
    """
    ignores: dict[Path, set[str]] = {}
    for dirpath_str, dirnames, filenames in os.walk(root):
        dp = Path(dirpath_str)
        if is_excluded(dp, root, excludes):
            dirnames.clear()
            continue
        for fname in filenames:
            if fname == LINTIGNORE_PREFIX:
                ignores.setdefault(dp, set()).add("__all__")
            elif fname.startswith(f"{LINTIGNORE_PREFIX}-"):
                rule = fname[len(LINTIGNORE_PREFIX) + 1 :]
                ignores.setdefault(dp, set()).add(rule)
    return ignores


def is_lintignored(
    path: Path,
    root: Path,
    rule: str,
    ignores: dict[Path, set[str]],
) -> bool:
    """Return True if *path* is covered by a ``.lintignore`` file for *rule*.

    Walks from *path* up to *root* checking each ancestor directory.
    """
    current = path if path.is_dir() else path.parent
    root = root.resolve()
    while True:
        rules = ignores.get(current)
        if rules and ("__all__" in rules or rule in rules):
            return True
        if current == root:
            break
        current = current.parent
    return False
