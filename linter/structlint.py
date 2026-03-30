#!/usr/bin/env python3
"""Structural linter: enforces file line limits and folder item limits."""

from __future__ import annotations

import argparse
import fnmatch
import json
import os
import sys
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
CONFIG_FILE = SCRIPT_DIR / "structlint.json"


def load_config() -> dict[str, Any]:
    with open(CONFIG_FILE) as f:
        return json.load(f)


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


def check_file_lines(
    filepath: Path, root: Path, max_lines: int,
) -> tuple[str, int] | None:
    try:
        count = len(filepath.read_text(errors="ignore").splitlines())
    except OSError:
        return None
    if count >= max_lines:
        rel = filepath.relative_to(root)
        msg = (
            f"{rel}:1:1: error: File has {count} lines "
            f"(limit {max_lines}) [max-file-lines]"
        )
        return (msg, count)
    return None


ANCHOR_FILES = ("__init__.py", "index.ts", "index.tsx", "index.js")


def _find_anchor_file(dirpath: Path, root: Path) -> str:
    """Find a real file inside the folder to attach the diagnostic to.

    Prefers common entry-point files (__init__.py, index.ts, etc.) so the
    error shows up inline when you open that file. Falls back to the first
    file alphabetically, then the directory path itself.
    """
    for name in ANCHOR_FILES:
        candidate = dirpath / name
        if candidate.exists():
            return str(candidate.relative_to(root))
    try:
        first = sorted(
            f for f in dirpath.iterdir()
            if f.is_file() and not f.name.startswith(".")
        )
        if first:
            return str(first[0].relative_to(root))
    except OSError:
        pass
    return str(dirpath.relative_to(root))


def check_folder_items(
    dirpath: Path, root: Path, max_items: int, excludes: list[str],
) -> tuple[str, int] | None:
    try:
        items = [
            i for i in dirpath.iterdir()
            if not i.name.startswith(".") and not _matches_any(i.name, excludes)
        ]
    except OSError:
        return None
    count = len(items)
    if count >= max_items:
        anchor = _find_anchor_file(dirpath, root)
        rel = dirpath.relative_to(root)
        msg = (
            f"{anchor}:1:1: error: Folder '{rel}' has {count} items "
            f"(limit {max_items}) [max-folder-items]"
        )
        return (msg, count)
    return None


def run_checks(root: Path) -> list[str]:
    config = load_config()
    rules: dict[str, int] = config["rules"]
    excludes: list[str] = config["exclude"]
    exceptions: dict[str, list[str]] = config["exceptions"]
    extensions: list[str] = config["include_extensions"]

    max_lines: int = rules["max-file-lines"]
    max_items: int = rules["max-folder-items"]
    errors: list[str] = []

    for dirpath_str, dirnames, filenames in os.walk(root):
        dp = Path(dirpath_str)

        if is_excluded(dp, root, excludes):
            dirnames.clear()
            continue

        rel_dir = str(dp.relative_to(root))
        if rel_dir != "." and not is_excepted(rel_dir, "max-folder-items", exceptions):
            result = check_folder_items(dp, root, max_items, excludes)
            if result:
                errors.append(result[0])

        for fname in filenames:
            fp = dp / fname
            if fp.suffix not in extensions:
                continue
            if is_excluded(fp, root, excludes):
                continue
            rel_file = str(fp.relative_to(root))
            if not is_excepted(rel_file, "max-file-lines", exceptions):
                result = check_file_lines(fp, root, max_lines)
                if result:
                    errors.append(result[0])

    return sorted(errors)


def print_results(errors: list[str]) -> None:
    print("structlint: checking...", flush=True)
    for err in errors:
        print(err, flush=True)
    count = len(errors)
    print(f"structlint: done. {count} error(s) found.", flush=True)


def watch_loop(root: Path) -> None:
    from watchfiles import watch, DefaultFilter

    print_results(run_checks(root))

    class SourceFilter(DefaultFilter):
        allowed_extensions = (".py", ".ts", ".tsx", ".js", ".jsx")

        def __call__(self, change: Any, path: str) -> bool:
            if not super().__call__(change, path):
                return False
            if Path(path).suffix in self.allowed_extensions:
                return True
            return Path(path).is_dir()

    for _changes in watch(root, watch_filter=SourceFilter()):
        print_results(run_checks(root))


def main() -> None:
    parser = argparse.ArgumentParser(description="Structural linter")
    parser.add_argument("--watch", action="store_true", help="Watch for changes")
    parser.add_argument("--root", type=str, default=".", help="Root directory")
    args = parser.parse_args()

    root = Path(args.root).resolve()

    if args.watch:
        watch_loop(root)
    else:
        errors = run_checks(root)
        print_results(errors)
        sys.exit(1 if errors else 0)


if __name__ == "__main__":
    main()
