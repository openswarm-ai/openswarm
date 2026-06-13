#!/usr/bin/env python3
"""Unified linter: orchestrates structural checks, dead-code detection, and lint tools."""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from checks import CheckError, is_excluded, is_excepted, is_lintignored, collect_lintignores
from checks.structural import check_file_lines, check_folder_items, check_nested_imports
from checks.vulture import run_vulture
from checks.ruff import run_ruff
from checks.eslint import run_eslint
from checks.knip import run_knip
from checks.endpoints import run_endpoint_check
from checks.classes import run_class_check
from checks.cycles import run_cycle_check
from checks.no_underscore_names import run_underscore_check
from watchfiles import watch, DefaultFilter

SCRIPT_DIR = Path(__file__).resolve().parent
CONFIG_FILE = SCRIPT_DIR / "config" / "config.json"

# Print order for the sections; also the order they run in.
SECTION_ORDER = [
    "structural", "vulture", "ruff", "no-underscore-names", "eslint",
    "knip", "endpoints", "classes", "import-cycles",
]


@dataclass
class LintResult:
    """Outcome of one full lint pass.

    ``sections`` maps each section name to its (sorted) error lines. ``incomplete``
    maps a section name to the reason it could not run; such a section is *not*
    the same as a clean one, so callers must surface it rather than trusting its
    empty error list as a zero count.
    """

    sections: dict[str, list[str]] = field(default_factory=dict)
    incomplete: dict[str, str] = field(default_factory=dict)

    def has_findings(self) -> bool:
        return any(self.sections.values())


def load_config() -> dict[str, Any]:
    with open(CONFIG_FILE) as f:
        return json.load(f)


def _structural_checks(
    root: Path,
    rules: dict[str, Any],
    enabled: dict[str, bool],
    excludes: list[str],
    exceptions: dict[str, list[str]],
    extensions: list[str],
    ignores: dict[Path, set[str]],
) -> list[str]:
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
        if (
            folder_items_on
            and rel_dir != "."
            and not is_excepted(rel_dir, "max-folder-items", exceptions)
            and not is_lintignored(dp, root, "max-folder-items", ignores)
        ):
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
            if (
                file_lines_on
                and not is_excepted(rel_file, "max-file-lines", exceptions)
                and not is_lintignored(fp, root, "max-file-lines", ignores)
            ):
                result = check_file_lines(fp, root, max_lines)
                if result:
                    structural_errors.append(result[0])
            if (
                nested_imports_on
                and check_imports
                and not is_excepted(rel_file, "no-nested-imports", exceptions)
                and not is_lintignored(fp, root, "no-nested-imports", ignores)
            ):
                structural_errors.extend(check_nested_imports(fp, root))

    return structural_errors


def run_checks(root: Path) -> LintResult:
    config = load_config()
    enabled: dict[str, bool] = config.get("enabled", {})
    rules: dict[str, Any] = config["rules"]
    excludes: list[str] = config["exclude"]
    exceptions: dict[str, list[str]] = config["exceptions"]
    extensions: list[str] = config["include_extensions"]
    ignores = collect_lintignores(root, excludes)

    result = LintResult()

    def run_section(name: str, fn: Callable[[], list[str]]) -> None:
        """Run one section, recording a failure as *incomplete* rather than
        letting an empty list masquerade as a clean result."""
        try:
            result.sections[name] = sorted(fn())
        except CheckError as e:
            result.sections[name] = []
            result.incomplete[name] = e.reason

    def _vulture() -> list[str]:
        if not enabled.get("vulture", True):
            return []
        confidence = rules.get("vulture-min-confidence")
        if confidence is None:
            return []
        threshold = rules.get("vulture-error-threshold", 100)
        return run_vulture(root, confidence, threshold, exceptions, ignores)

    run_section("structural", lambda: _structural_checks(
        root, rules, enabled, excludes, exceptions, extensions, ignores,
    ))
    run_section("vulture", _vulture)
    run_section("ruff", lambda: run_ruff(
        root, rules.get("ruff-select", "F401,F811,F841,ARG001,ARG002"), exceptions, ignores,
    ) if enabled.get("ruff", True) else [])
    run_section("no-underscore-names", lambda: run_underscore_check(
        root, exceptions, excludes, ignores,
    ) if enabled.get("no-underscore-names", True) else [])
    run_section("eslint", lambda: run_eslint(root, ignores) if enabled.get("eslint", True) else [])
    run_section("knip", lambda: run_knip(root, ignores) if enabled.get("knip", True) else [])
    run_section("endpoints", lambda: run_endpoint_check(
        root, exceptions, rules.get("endpoint-ignore-routes", []), ignores,
    ) if enabled.get("endpoints", True) else [])
    run_section("classes", lambda: run_class_check(
        root, exceptions, excludes, ignores,
    ) if enabled.get("classes", True) else [])
    run_section("import-cycles", lambda: run_cycle_check(
        root, excludes, rules.get("import-cycle-aliases", {}), exceptions, ignores,
    ) if enabled.get("import-cycles", True) else [])

    return result


def _print_section(name: str, errors: list[str], reason: str | None) -> None:
    print(f"{name}: checking...", flush=True)
    for e in errors:
        print(e, flush=True)
    if reason is not None:
        # Emit a problemMatcher-catchable line so the IDE Problems panel shows the
        # run was partial, then a human-readable status line for the terminal.
        print(
            f"linter/lint.py:1:1: error: [linter] '{name}' check INCOMPLETE: "
            f"{reason} — error counts are unreliable until this is resolved",
            flush=True,
        )
        print(f"{name}: done. INCOMPLETE — {reason}.", flush=True)
    else:
        print(f"{name}: done. {len(errors)} error(s) found.", flush=True)


def print_results(result: LintResult) -> None:
    for name in SECTION_ORDER:
        _print_section(name, result.sections.get(name, []), result.incomplete.get(name))


def watch_loop(root: Path) -> None:

    config_dir = SCRIPT_DIR / "config"

    print_results(run_checks(root))

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
            if p.name.startswith(".lintignore"):
                return True
            return Path(path).is_dir()

    for _changes in watch(root, watch_filter=SourceFilter()):
        print_results(run_checks(root))


def main() -> None:
    parser = argparse.ArgumentParser(description="Unified linter")
    parser.add_argument("--watch", action="store_true", help="Watch for changes")
    parser.add_argument("--root", type=str, default=".", help="Root directory")
    args = parser.parse_args()

    root = Path(args.root).resolve()

    if args.watch:
        watch_loop(root)
    else:
        result = run_checks(root)
        print_results(result)
        # Exit non-zero on findings OR on an incomplete run, so a partial pass is
        # never mistaken for a clean one by CI or print_errors.sh.
        sys.exit(1 if result.has_findings() or result.incomplete else 0)


if __name__ == "__main__":
    main()
