"""Ruff runner: per-file, scope-aware lint that vulture's global name-set can't do.

Owns the checks ruff is strictly better at than vulture:
  - F401 unused imports (real per-file scope; honors __all__ / redundant-alias re-exports)
  - F811 redefinition of an unused name
  - F841 unused local variable assignment
  - ARG001/ARG002 unused function/method arguments

Vulture is narrowed (see checks/vulture.py) to only emit dead functions, methods,
classes, and attributes, the whole-program reachability that ruff structurally
does not attempt. The two are complementary, not redundant.
"""

from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

from . import CheckError, is_excepted, is_lintignored

# Generous because the first run after a window reload races the editor's
# startup load with a cold ruff cache; a tight limit there is exactly what made
# the check time out and silently report zero.
_TIMEOUT = 120

# Ruff emits ANSI color into its concise output even on a non-tty / NO_COLOR;
# strip the escapes before parsing so the regex sees plain text.
_ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")

# `path:line:col: CODE message`. The optional `[*]` fixable marker is dropped.
_LINE_RE = re.compile(r"^(?P<path>.+?):(?P<line>\d+):(?P<col>\d+): (?P<code>[A-Z]+\d+) (?P<msg>.+)$")


def run_ruff(
    root: Path,
    select: str,
    exceptions: dict[str, list[str]],
    ignores: dict[Path, set[str]] | None = None,
) -> list[str]:
    """Run ruff on the Python backend and return errors."""
    ruff_bin = root / "backend" / ".venv" / "bin" / "ruff"
    if not ruff_bin.exists():
        found = shutil.which("ruff")
        if not found:
            raise CheckError("ruff executable not found in backend/.venv/bin or PATH")
        ruff_bin = Path(found)

    targets = ["backend"]
    if (root / "debug.py").exists():
        targets.append("debug.py")
    cmd = [
        str(ruff_bin), "check", *targets,
        "--isolated",  # ignore any stray pyproject/ruff.toml so the linter is hermetic
        "--select", select,
        "--output-format", "concise",
        "--no-fix",
        "--exclude", ".venv,__pycache__,data,uv-bin,webapp_template,.runner-venv",
    ]

    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, cwd=str(root), timeout=_TIMEOUT,
        )
    except subprocess.TimeoutExpired as e:
        raise CheckError(f"timed out after {_TIMEOUT}s (machine under load or cold cache)") from e
    except OSError as e:
        raise CheckError(f"failed to launch ruff ({e})") from e

    # ruff exits 0 (no findings) or 1 (findings) on success; anything else with
    # no parseable output means ruff itself errored (e.g. could not write its
    # cache) — surface it instead of treating the empty stdout as "clean".
    if result.returncode not in (0, 1) and not result.stdout.strip():
        detail = _ANSI_RE.sub("", result.stderr).strip()[:300] or "no output"
        raise CheckError(f"ruff exited with code {result.returncode}: {detail}")

    errors: list[str] = []
    for line in result.stdout.strip().splitlines():
        m = _LINE_RE.match(_ANSI_RE.sub("", line).strip())
        if not m:
            continue
        filepath = m.group("path")
        if is_excepted(filepath, "ruff", exceptions):
            continue
        if ignores and is_lintignored(root / filepath, root, "ruff", ignores):
            continue
        errors.append(
            f"{filepath}:{m.group('line')}:{m.group('col')}: "
            f"error: [ruff] {m.group('code')} {m.group('msg')}"
        )
    return errors
