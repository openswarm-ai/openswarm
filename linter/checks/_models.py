"""Shared model metadata for the linter.

Pydantic ``BaseModel`` field names are collected here so independent checks can
agree on which attribute names belong to a serialization schema, and are
therefore "used" even when the only *read* happens across a language boundary
(serialized to JSON over the wire and consumed by the frontend) which vulture's
Python-only analysis structurally cannot see.

Framework detection lives in ONE place so checks/classes.py and
checks/vulture.py never drift on what counts as a model. This module owns no
section of its own and is not gated by config "enabled" flags, so any check that
imports it works regardless of which sections are turned on.
"""

from __future__ import annotations

import ast
from functools import lru_cache
from pathlib import Path

FRAMEWORK_BASES = {"BaseModel"}


def is_framework_model(cls: ast.ClassDef) -> bool:
    """True when *cls* subclasses a known framework base (e.g. pydantic BaseModel)."""
    return any(
        (isinstance(b, ast.Name) and b.id in FRAMEWORK_BASES)
        or (isinstance(b, ast.Attribute) and b.attr in FRAMEWORK_BASES)
        for b in cls.bases
    )


@lru_cache(maxsize=512)
def _fields_in_file_cached(filepath: str, _mtime: float) -> frozenset[str]:
    """Annotated field names on framework models in *filepath*.

    Keyed on *(filepath, mtime)* so the long-lived watch process re-parses a file
    after it is edited instead of returning a stale set from an earlier version.
    """
    try:
        tree = ast.parse(Path(filepath).read_text())
    except (OSError, SyntaxError):
        return frozenset()
    names: set[str] = set()
    for node in ast.walk(tree):
        if not isinstance(node, ast.ClassDef) or not is_framework_model(node):
            continue
        # Direct body only: pydantic fields are annotated assignments
        # (``name: type`` / ``name: type = default``). Nested models are picked
        # up on their own ClassDef pass by ast.walk.
        for stmt in node.body:
            if isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name):
                names.add(stmt.target.id)
    return frozenset(names)


def _fields_in_file(filepath: Path) -> frozenset[str]:
    try:
        mtime = filepath.stat().st_mtime
    except OSError:
        return frozenset()
    return _fields_in_file_cached(str(filepath), mtime)


def collect_pydantic_field_names(root: Path) -> set[str]:
    """Every annotated field name on a ``BaseModel`` subclass under ``backend/``.

    Consumed by checks/vulture.py to treat ``obj.<field> = ...`` writes as live
    even when the only read is across the Python/TS boundary, which vulture would
    otherwise report as an unused attribute.
    """
    backend = root / "backend"
    if not backend.is_dir():
        return set()
    names: set[str] = set()
    for pyfile in backend.rglob("*.py"):
        parts = pyfile.parts
        if ".venv" in parts or "__pycache__" in parts:
            continue
        names |= _fields_in_file(pyfile)
    return names
