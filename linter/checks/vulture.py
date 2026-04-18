"""Vulture dead-code detection runner.

Class-body findings (fields, methods inside a class) are filtered out here
and handled separately by checks/classes.py which understands Pydantic.
"""

from __future__ import annotations

import ast
import re
import shutil
import subprocess
from functools import lru_cache
from pathlib import Path

from . import is_excepted, is_lintignored

CONFIG_DIR = Path(__file__).resolve().parent.parent / "config"


@lru_cache(maxsize=64)
def _class_line_ranges(filepath: str) -> list[tuple[int, int]]:
    """Return (start, end) line ranges for all class bodies in *filepath*."""
    try:
        tree = ast.parse(Path(filepath).read_text())
    except (OSError, SyntaxError):
        return []
    ranges: list[tuple[int, int]] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef):
            end = max(getattr(n, "lineno", node.lineno) for n in ast.walk(node))
            ranges.append((node.lineno, end))
    return ranges


def _is_inside_class(filepath: str, lineno: int) -> bool:
    """True when *lineno* is strictly inside a class body.

    The class declaration line itself (``class Foo:``) is *not* considered
    inside, so vulture's "unused class" findings still pass through.
    """
    return any(start < lineno <= end for start, end in _class_line_ranges(filepath))


def run_vulture(
    root: Path, min_confidence: int, error_threshold: int,
    exceptions: dict[str, list[str]],
    ignores: dict[Path, set[str]] | None = None,
) -> list[str]:
    """Run vulture on the Python backend and return errors."""
    vulture_bin = root / "backend" / ".venv" / "bin" / "vulture"
    if not vulture_bin.exists():
        found = shutil.which("vulture")
        if not found:
            return []
        vulture_bin = Path(found)

    whitelist = CONFIG_DIR / "vulture_whitelist.py"
    targets = ["backend"]
    if (root / "debug.py").exists():
        targets.append("debug.py")
    cmd = [str(vulture_bin), *targets]
    if whitelist.exists():
        cmd.append(str(whitelist))
    cmd.extend([
        "--min-confidence", str(min_confidence),
        "--exclude", ".venv,__pycache__,data,uv-bin",
        "--ignore-decorators", "@*.router.*,@*.websocket,@pytest.fixture,@pytest.fixture*",
        "--ignore-names", "cls",
    ])

    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, cwd=str(root), timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired):
        return []

    errors: list[str] = []
    for line in result.stdout.strip().splitlines():
        m = re.match(r"^(.+):(\d+): (.+)$", line)
        if not m:
            continue
        filepath, lineno, message = m.groups()
        if is_excepted(filepath, "vulture", exceptions):
            continue
        if ignores and is_lintignored(root / filepath, root, "vulture", ignores):
            continue
        if _is_inside_class(str(root / filepath), int(lineno)):
            continue
        conf = re.search(r"\((\d+)% confidence\)", message)
        confidence = int(conf.group(1)) if conf else 0
        severity = "error" if confidence >= error_threshold else "warning"
        errors.append(f"{filepath}:{lineno}:1: {severity}: [vulture] {message}")
    return errors
