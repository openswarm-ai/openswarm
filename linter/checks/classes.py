"""Class-level dead code detection with framework awareness.

Pydantic BaseModel subclasses are auto-whitelisted: every annotated field is
part of the serialization schema and therefore intentionally "used".

Non-framework classes are skipped for now (tier 2 — future cross-referencing).
"""

from __future__ import annotations

import ast
from pathlib import Path

from . import is_excepted, is_excluded, is_lintignored

FRAMEWORK_BASES = {"BaseModel"}


def _is_framework_model(cls: ast.ClassDef) -> bool:
    return any(
        (isinstance(b, ast.Name) and b.id in FRAMEWORK_BASES)
        or (isinstance(b, ast.Attribute) and b.attr in FRAMEWORK_BASES)
        for b in cls.bases
    )


def run_class_check(
    root: Path,
    exceptions: dict[str, list[str]],
    excludes: list[str],
    ignores: dict[Path, set[str]] | None = None,
) -> list[str]:
    """Analyse classes in backend Python files and return errors."""
    errors: list[str] = []
    backend = root / "backend"
    if not backend.is_dir():
        return errors

    for pyfile in sorted(backend.rglob("*.py")):
        if is_excluded(pyfile, root, excludes):
            continue
        rel = str(pyfile.relative_to(root))
        if is_excepted(rel, "classes", exceptions):
            continue
        if ignores and is_lintignored(pyfile, root, "classes", ignores):
            continue
        try:
            source = pyfile.read_text()
            tree = ast.parse(source, filename=rel)
        except (OSError, SyntaxError):
            continue

        for node in ast.walk(tree):
            if not isinstance(node, ast.ClassDef):
                continue
            if _is_framework_model(node):
                continue
            # Tier 2 placeholder: non-framework classes are skipped until
            # cross-reference analysis is implemented.

    return errors
