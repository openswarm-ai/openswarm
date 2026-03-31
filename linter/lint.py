#!/usr/bin/env python3
"""Unified linter: orchestrates structural checks, dead-code detection, and lint tools."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

from checks import is_excluded, is_excepted
from checks.structural import check_file_lines, check_folder_items, check_nested_imports
from checks.vulture import run_vulture
from checks.eslint import run_eslint
from checks.knip import run_knip
from checks.endpoints import run_endpoint_check

SCRIPT_DIR = Path(__file__).resolve().parent
CONFIG_FILE = SCRIPT_DIR / "config" / "config.json"


def load_config() -> dict[str, Any]:
    with open(CONFIG_FILE) as f:
        return json.load(f)


def run_checks(root: Path) -> tuple[list[str], list[str], list[str], list[str], list[str]]:
    config = load_config()
    enabled: dict[str, bool] = config.get("enabled", {})
    rules: dict[str, int] = config["rules"]
    excludes: list[str] = config["exclude"]
    exceptions: dict[str, list[str]] = config["exceptions"]
    extensions: list[str] = config["include_extensions"]

    max_lines: int = rules["max-file-lines"]
    max_items: int = rules["max-folder-items"]
    check_imports: bool = rules.get("no-nested-imports", False)
    structural_errors: list[str] = []

    file_lines_on = enabled.get("max-file-lines", True)
    folder_items_on = enabled.get("max-folder-items", True)
    nested_imports_on = enabled.get("no-nested-imports", True)

    for dirpath_str, dirnames, filenames in os.walk(root):
        dp = Path(dirpath_str)

        if is_excluded(dp, root, excludes):
            dirnames.clear()
            continue

        rel_dir = str(dp.relative_to(root))
        if folder_items_on and rel_dir != "." and not is_excepted(rel_dir, "max-folder-items", exceptions):
            result = check_folder_items(dp, root, max_items, excludes)
            if result:
                structural_errors.append(result[0])

        for fname in filenames:
            fp = dp / fname
            if fp.suffix not in extensions:
                continue
            if is_excluded(fp, root, excludes):
                continue
            rel_file = str(fp.relative_to(root))
            if file_lines_on and not is_excepted(rel_file, "max-file-lines", exceptions):
                result = check_file_lines(fp, root, max_lines)
                if result:
                    structural_errors.append(result[0])
            if nested_imports_on and check_imports and not is_excepted(rel_file, "no-nested-imports", exceptions):
                structural_errors.extend(check_nested_imports(fp, root))

    vulture_errors: list[str] = []
    if enabled.get("vulture", True):
        vulture_confidence = rules.get("vulture-min-confidence")
        if vulture_confidence is not None:
            vulture_error_threshold = rules.get("vulture-error-threshold", 100)
            vulture_errors = run_vulture(
                root, vulture_confidence, vulture_error_threshold, exceptions,
            )

    eslint_errors = run_eslint(root) if enabled.get("eslint", True) else []
    knip_errors = run_knip(root) if enabled.get("knip", True) else []
    endpoint_ignore_routes: list[str] = rules.get("endpoint-ignore-routes", [])
    endpoint_errors = run_endpoint_check(root, exceptions, endpoint_ignore_routes) if enabled.get("endpoints", True) else []

    return sorted(structural_errors), sorted(vulture_errors), sorted(eslint_errors), sorted(knip_errors), sorted(endpoint_errors)


def _print_section(name: str, errors: list[str]) -> None:
    print(f"{name}: checking...", flush=True)
    for e in errors:
        print(e, flush=True)
    print(f"{name}: done. {len(errors)} error(s) found.", flush=True)


def print_results(
    structural_errors: list[str], vulture_errors: list[str],
    eslint_errors: list[str], knip_errors: list[str],
    endpoint_errors: list[str],
) -> None:
    _print_section("structural", structural_errors)
    _print_section("vulture", vulture_errors)
    _print_section("eslint", eslint_errors)
    _print_section("knip", knip_errors)
    _print_section("endpoints", endpoint_errors)


def watch_loop(root: Path) -> None:
    from watchfiles import watch, DefaultFilter

    config_dir = SCRIPT_DIR / "config"

    print_results(*run_checks(root))

    class SourceFilter(DefaultFilter):
        allowed_extensions = (".py", ".ts", ".tsx", ".js", ".jsx")

        def __call__(self, change: Any, path: str) -> bool:
            if not super().__call__(change, path):
                return False
            if Path(path).suffix in self.allowed_extensions:
                return True
            p = Path(path)
            if p.suffix == ".json" and (p.parent == SCRIPT_DIR or p.parent == config_dir):
                return True
            return Path(path).is_dir()

    for _changes in watch(root, watch_filter=SourceFilter()):
        print_results(*run_checks(root))


def main() -> None:
    parser = argparse.ArgumentParser(description="Unified linter")
    parser.add_argument("--watch", action="store_true", help="Watch for changes")
    parser.add_argument("--root", type=str, default=".", help="Root directory")
    args = parser.parse_args()

    root = Path(args.root).resolve()

    if args.watch:
        watch_loop(root)
    else:
        results = run_checks(root)
        print_results(*results)
        sys.exit(1 if any(results) else 0)


if __name__ == "__main__":
    main()
