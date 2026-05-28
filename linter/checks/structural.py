"""Structural checks: file length, folder size, and nested imports."""

from __future__ import annotations

import ast
from pathlib import Path

from . import _matches_any

ANCHOR_FILES = ("__init__.py", "index.ts", "index.tsx", "index.js")


def _find_anchor_file(dirpath: Path, root: Path) -> str:
    """Find a real file inside the folder to attach the diagnostic to.

    Prefers common entry-point files (__init__.py, index.ts, etc.) so the
    error shows up inline when you open that file.  Falls back to the first
    file alphabetically, then the directory path itself.
    """
    for name in ANCHOR_FILES:
        candidate = dirpath / name
        if candidate.exists():
            return str(candidate.relative_to(root))
    try:
        first = sorted(
            f for f in dirpath.iterdir()
            if f.is_file() and not f.name.startswith(".")
        )
        if first:
            return str(first[0].relative_to(root))
    except OSError:
        pass
    return str(dirpath.relative_to(root))


def check_file_lines(
    filepath: Path, root: Path, max_lines: int,
) -> tuple[str, int] | None:
    try:
        count = len(filepath.read_text(errors="ignore").splitlines())
    except OSError:
        return None
    if count >= max_lines:
        rel = filepath.relative_to(root)
        msg = (
            f"{rel}:1:1: error: "
            f"[max-file-lines] File has {count} lines (limit {max_lines})"
        )
        return (msg, count)
    return None


def check_folder_items(
    dirpath: Path, root: Path, max_items: int, excludes: list[str],
) -> tuple[str, int] | None:
    try:
        items = [
            i for i in dirpath.iterdir()
            if not i.name.startswith(".") and not _matches_any(i.name, excludes)
        ]
    except OSError:
        return None
    count = len(items)
    # the cap is the most you're allowed: 7 items is fine, the 8th is the straw.
    if count > max_items:
        anchor = _find_anchor_file(dirpath, root)
        rel = dirpath.relative_to(root)
        msg = (
            f"{anchor}:1:1: error: "
            f"[max-folder-items] Folder '{rel}' has {count} items (limit {max_items})"
        )
        return (msg, count)
    return None


def check_nested_imports(filepath: Path, root: Path) -> list[str]:
    """Detect import statements inside function or method bodies."""
    if filepath.suffix != ".py":
        return []
    try:
        source = filepath.read_text(errors="ignore")
        tree = ast.parse(source, filename=str(filepath))
    except (OSError, SyntaxError):
        return []

    errors: list[str] = []
    rel = str(filepath.relative_to(root))

    def _visit(node: ast.AST, in_function: bool) -> None:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            in_function = True
        if in_function and isinstance(node, (ast.Import, ast.ImportFrom)):
            if isinstance(node, ast.ImportFrom):
                name = node.module or ""
            else:
                name = ", ".join(a.name for a in node.names)
            errors.append(
                f"{rel}:{node.lineno}:1: error: "
                f"[no-nested-imports] Nested import '{name}'"
            )
        for child in ast.iter_child_nodes(node):
            _visit(child, in_function)

    _visit(tree, False)
    return errors
