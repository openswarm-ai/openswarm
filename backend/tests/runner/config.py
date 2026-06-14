"""Runner configuration: paths + the test venv interpreter.

A single ``config.json`` next to this module centralizes everything that used to
be hard-coded in ``discovery.py`` / ``run.py`` so the runner can be dropped into
another repo by editing data instead of code:

    repo_root        where pytest runs (cwd); test_paths are relative to it
    test_paths       default search roots when no paths are given
    venv_python      the interpreter the *tests* run in (separate from the
                     runner's own venv); falls back to the current interpreter
    coverage_source  packages measured under --cov, and the report path filter
    icons            picker glyph tier (a *ceiling*): "nerd" | "emoji" |
                     "unicode" | "ascii", default "unicode". Each icon falls
                     back to the fanciest variant at or below this tier, so a
                     terminal without a Nerd Font still renders the rest.

All paths in the JSON are resolved relative to this directory (the runner
folder) unless absolute. Missing keys fall back to today's behavior.
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from pathlib import Path

RUNNER_DIR = Path(__file__).resolve().parent
DEFAULT_CONFIG_PATH = RUNNER_DIR / "config.json"

# Defaults that reproduce the pre-config behavior of the runner.
_DEFAULT_REPO_ROOT = RUNNER_DIR.parents[1]  # <repo>/tests/runner -> <repo>
_DEFAULT_TEST_PATHS = ["tests/unit", "tests/api"]
_DEFAULT_COVERAGE_SOURCE = ["backend"]

# Allowed picker glyph tiers, fanciest first. "unicode" is the safe default:
# plain BMP shapes that render on any terminal without a patched font.
_ICON_TIERS = ("nerd", "emoji", "unicode", "ascii")
_DEFAULT_ICONS = "unicode"


@dataclass(frozen=True)
class Config:
    repo_root: Path
    test_paths: list[str]
    venv_python: str
    coverage_source: list[str]
    icons: str


def _resolve(base: Path, value: str) -> Path:
    p = Path(value).expanduser()
    return p if p.is_absolute() else (base / p).resolve()


def load_config(path: Path | None = None) -> Config:
    """Load and resolve the runner config. Unknown/missing keys use defaults."""
    cfg_path = path or DEFAULT_CONFIG_PATH
    raw: dict = {}
    if cfg_path.is_file():
        raw = json.loads(cfg_path.read_text())

    repo_root = (
        _resolve(RUNNER_DIR, raw["repo_root"])
        if raw.get("repo_root")
        else _DEFAULT_REPO_ROOT
    )

    test_paths = raw.get("test_paths") or list(_DEFAULT_TEST_PATHS)
    coverage_source = raw.get("coverage_source") or list(_DEFAULT_COVERAGE_SOURCE)

    # An unknown/misspelled tier silently falls back to the safe default rather
    # than crashing the picker on launch.
    icons = raw.get("icons")
    if icons not in _ICON_TIERS:
        icons = _DEFAULT_ICONS

    # The test interpreter is resolved against repo_root. If it is unset or does
    # not exist, fall back to the interpreter running the runner so the tool
    # still works in a single-venv setup. We deliberately do NOT call
    # ``.resolve()`` here: a venv's ``python`` is a symlink to the base
    # interpreter, and following it would dereference away the venv.
    venv_python = sys.executable
    if raw.get("venv_python"):
        candidate = Path(raw["venv_python"]).expanduser()
        if not candidate.is_absolute():
            candidate = repo_root / candidate
        if candidate.exists():
            venv_python = str(candidate)

    return Config(
        repo_root=repo_root,
        test_paths=test_paths,
        venv_python=venv_python,
        coverage_source=coverage_source,
        icons=icons,
    )
