"""Test discovery by delegating to pytest's own collector.

We never parse test files ourselves — we ask pytest to collect and emit node
IDs. This matches pytest exactly (handles asyncio_mode=auto, parametrization,
classes, markers) instead of guessing from decorators like the old runner did.

Collection runs in the configured *test* venv (``config.venv_python``), because
collecting imports the test modules and therefore needs the project's full test
dependencies — not the runner's own venv.
"""

from __future__ import annotations

import subprocess

from tests.runner.config import load_config

_CONFIG = load_config()

# Kept for backwards-compatible imports (e.g. run.py uses it for relpath).
REPO_ROOT = _CONFIG.repo_root

# Default search roots come from config; we avoid scanning tests/runner itself.
DEFAULT_PATHS: list[str] = _CONFIG.test_paths


def discover(paths: list[str] | None = None, keyword: str | None = None) -> list[str]:
    """Return pytest node IDs for the given paths (optionally -k filtered).

    Raises RuntimeError if pytest collection itself errored.
    """
    search = paths or DEFAULT_PATHS
    cmd = [
        _CONFIG.venv_python,
        "-m",
        "pytest",
        "-o",
        "addopts=",  # drop the global -q so node IDs print one per line
        "--collect-only",
        "-q",
        *search,
    ]
    if keyword:
        cmd += ["-k", keyword]

    proc = subprocess.run(
        cmd, capture_output=True, text=True, cwd=str(REPO_ROOT)
    )
    # Collection errors (import errors, bad -k) → surface stderr/stdout.
    if proc.returncode not in (0, 5):  # 5 = "no tests collected"
        raise RuntimeError(
            f"pytest collection failed (exit {proc.returncode}):\n"
            f"{proc.stdout}\n{proc.stderr}".strip()
        )

    return [line.strip() for line in proc.stdout.splitlines() if "::" in line]
