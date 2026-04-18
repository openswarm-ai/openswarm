"""ESLint runner for the TypeScript frontend."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

from . import is_lintignored


def run_eslint(root: Path, ignores: dict[Path, set[str]] | None = None) -> list[str]:
    """Run ESLint on the TypeScript frontend and return errors."""
    frontend_dir = root / "frontend"
    eslint_bin = frontend_dir / "node_modules" / ".bin" / "eslint"
    if not eslint_bin.exists():
        return []

    cmd = [str(eslint_bin), "src/", "--format", "json", "--no-warn-ignored"]
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True,
            cwd=str(frontend_dir), timeout=60,
        )
    except (OSError, subprocess.TimeoutExpired):
        return []

    try:
        data = json.loads(result.stdout)
    except (json.JSONDecodeError, ValueError):
        return []

    errors: list[str] = []
    for entry in data:
        try:
            filepath = Path(entry["filePath"])
            rel = str(filepath.relative_to(root))
        except (ValueError, KeyError):
            continue
        if ignores and is_lintignored(filepath, root, "eslint", ignores):
            continue
        for msg in entry.get("messages", []):
            sev = "error" if msg.get("severity", 0) >= 2 else "warning"
            text = msg.get("message", "").replace("\n", " ").strip()
            rule = msg.get("ruleId") or "unknown"
            errors.append(
                f"{rel}:{msg.get('line', 1)}:{msg.get('column', 1)}: "
                f"{sev}: [eslint] {text} ({rule})"
            )
    return errors
