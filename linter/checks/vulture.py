"""Vulture dead-code detection runner."""

from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

from . import is_excepted

CONFIG_DIR = Path(__file__).resolve().parent.parent / "config"


def run_vulture(
    root: Path, min_confidence: int, error_threshold: int,
    exceptions: dict[str, list[str]],
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
        "--ignore-decorators", "@*.router.*",
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
        conf = re.search(r"\((\d+)% confidence\)", message)
        confidence = int(conf.group(1)) if conf else 0
        severity = "error" if confidence >= error_threshold else "warning"
        errors.append(f"{filepath}:{lineno}:1: {severity}: [vulture] {message}")
    return errors
