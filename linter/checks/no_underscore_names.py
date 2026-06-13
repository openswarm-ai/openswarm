"""Ban leading-underscore names that dead-code tooling silently skips.

Pylance's reportUnusedVariable, ruff's dummy-variable-rgx (F841/ARG0xx), and
vulture all treat a leading underscore as "intentionally private/unused" and
stop reporting it -- which makes ``_name`` a blind spot for dead-code detection.
This check bans the prefix so nothing can hide behind it.

Exempt: dunders (``__init__`` and friends, i.e. ``__x__``) and the bare ``_``
throwaway (``for _ in ...`` / ``a, _ = unpack()``). Everything else starting
with ``_`` is flagged, including name-mangled ``__x``.

Covers function/method names, arguments (incl. lambda), class names, variable
bindings (assignments, annotations, walrus, loop/with/except targets, tuple
unpacking), instance/class attribute writes (``self._x = ...``), and import
aliases. Scoped to ``backend/`` Python, like checks/classes.py.
"""

from __future__ import annotations

import ast
from collections.abc import Callable
from pathlib import Path

from . import is_excepted, is_excluded, is_lintignored

RULE = "no-underscore-names"

Report = Callable[[str, int, int, str], None]


def _is_dunder(name: str) -> bool:
    """True for ``__x__`` style names that Python requires (``__init__`` etc.)."""
    return len(name) > 4 and name.startswith("__") and name.endswith("__")


def _flagged(name: str) -> bool:
    if name == "_" or not name.startswith("_"):
        return False
    return not _is_dunder(name)


def _report_targets(target: ast.AST, report: Report) -> None:
    """Walk an assignment/loop target down to the names it binds."""
    if isinstance(target, ast.Name):
        report(target.id, target.lineno, target.col_offset, "variable")
    elif isinstance(target, ast.Attribute):
        # self._x = ... / cls._x = ...: the bound name is the attribute itself.
        report(target.attr, target.end_lineno or target.lineno, _attr_col(target), "attribute")
    elif isinstance(target, ast.Starred):
        _report_targets(target.value, report)
    elif isinstance(target, (ast.Tuple, ast.List)):
        for elt in target.elts:
            _report_targets(elt, report)
    # ast.Subscript (``d["_x"] = ...``) is not a name binding and is skipped.


def _attr_col(node: ast.Attribute) -> int:
    """Best-effort column for the attribute name (after the dot)."""
    # value.end_col_offset points just past ``value``; +1 skips the dot.
    end = getattr(node.value, "end_col_offset", None)
    return (end + 1) if end is not None else node.col_offset


def _args(a: ast.arguments) -> list[ast.arg | None]:
    return [*a.posonlyargs, *a.args, *a.kwonlyargs, a.vararg, a.kwarg]


def _check_tree(tree: ast.AST, rel: str) -> list[str]:
    errors: list[str] = []
    seen: set[tuple[int, int, str]] = set()

    def report(name: str, lineno: int, col: int, kind: str) -> None:
        if not _flagged(name):
            return
        key = (lineno, col, name)
        if key in seen:
            return
        seen.add(key)
        errors.append(
            f"{rel}:{lineno}:{col + 1}: error: "
            f"[{RULE}] {kind} '{name}' has a leading underscore"
        )

    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            report(node.name, node.lineno, node.col_offset, "function")
            for arg in _args(node.args):
                if arg is not None:
                    report(arg.arg, arg.lineno, arg.col_offset, "argument")
        elif isinstance(node, ast.Lambda):
            for arg in _args(node.args):
                if arg is not None:
                    report(arg.arg, arg.lineno, arg.col_offset, "argument")
        elif isinstance(node, ast.ClassDef):
            report(node.name, node.lineno, node.col_offset, "class")
        elif isinstance(node, (ast.Assign, ast.AnnAssign, ast.NamedExpr)):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            for t in targets:
                _report_targets(t, report)
        elif isinstance(node, (ast.For, ast.AsyncFor, ast.comprehension)):
            _report_targets(node.target, report)
        elif isinstance(node, (ast.With, ast.AsyncWith)):
            for item in node.items:
                if item.optional_vars is not None:
                    _report_targets(item.optional_vars, report)
        elif isinstance(node, ast.ExceptHandler) and node.name:
            report(node.name, node.lineno, node.col_offset, "exception")
        elif isinstance(node, ast.Import):
            for alias in node.names:
                report(
                    alias.asname or alias.name.split(".")[0],
                    node.lineno, node.col_offset, "import",
                )
        elif isinstance(node, ast.ImportFrom):
            for alias in node.names:
                if alias.name != "*":
                    report(alias.asname or alias.name, node.lineno, node.col_offset, "import")

    return errors


def run_underscore_check(
    root: Path,
    exceptions: dict[str, list[str]],
    excludes: list[str],
    ignores: dict[Path, set[str]] | None = None,
) -> list[str]:
    """Flag leading-underscore names in backend Python files."""
    errors: list[str] = []
    backend = root / "backend"
    if not backend.is_dir():
        return errors

    for pyfile in sorted(backend.rglob("*.py")):
        if is_excluded(pyfile, root, excludes):
            continue
        rel = str(pyfile.relative_to(root))
        if is_excepted(rel, RULE, exceptions):
            continue
        if ignores and is_lintignored(pyfile, root, RULE, ignores):
            continue
        try:
            tree = ast.parse(pyfile.read_text(), filename=rel)
        except (OSError, SyntaxError):
            continue
        errors.extend(_check_tree(tree, rel))

    return errors
