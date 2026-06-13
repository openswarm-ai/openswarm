"""Cross-file/class privacy for the ``p_`` naming convention (Java ``private``).

A name prefixed with ``p_`` (or ``P_`` -- the leading p is case-insensitive, so
UPPER_SNAKE constants like ``P_SECRET`` count too) is private to the scope that
owns it, enforced the way Java enforces ``private``:

  * **Module-level** ``p_`` symbols (top-level ``def`` / ``class`` / assignment)
    are **file-private** -- usable anywhere in their own file, nowhere else.
  * **Class members** (``def p_m``, ``self.p_x = ...``, and class-body fields
    ``p_x: T``) are **class-private** -- any ``recv.p_x`` is legal only when it
    appears lexically inside the owning class (or a class nested within it),
    matching Java's type-scoped ``private`` while side-stepping type inference.

Strict: a subclass in another file reaching a base's ``p_`` member is a
violation (Java ``private``, not ``protected``). Nested/inner classes may reach
the enclosing class's members and vice versa (the whole enclosing-class stack is
checked). No exemptions -- tests and ``__init__.py`` re-exports are enforced.

How access is detected (no type inference needed): Python reaches class members
only through attribute access (``self.p_x`` / ``obj.p_x``) and module-level
symbols only by bare name (legal in-file) or ``module.p_x`` / ``from m import
p_x`` across files. So the access *form* selects the scoping rule:

  * ``recv.p_x`` (attribute load)        -> class rule, else module rule
  * ``from m import p_x``                 -> module rule (cross-file import = leak)

Two passes: phase 1 records ownership, phase 2 checks references against it.
Scoped to ``backend/`` Python, like checks/classes.py.
"""

from __future__ import annotations

import ast
import re
from pathlib import Path

from . import is_excepted, is_excluded, is_lintignored

RULE = "p-private"

# Inline suppression, mirroring vulture's: `# p-private-ignore` (bare) silences
# any p-private finding on the line; `# p-private-ignore: p_x, p_y` only silences
# when the finding names one of the listed symbols (the noqa-with-codes form).
# The comment goes on the *reference* line (where the error is reported), e.g.
# `legacy.p_state  # p-private-ignore: p_state`.
_INLINE_IGNORE_RE = re.compile(r"#\s*p-private-ignore\b(?::\s*(?P<names>.*))?")

# name -> set of relative file paths that define it at module level
ModuleOwners = dict[str, set[str]]
# name -> set of (relative file path, qualified class name) that define it as a member
ClassOwners = dict[str, set[tuple[str, str]]]


def _is_p(name: str) -> bool:
    # Case-insensitive on the leading p so UPPER_SNAKE constants (P_SECRET) count
    # as private too, not just lowercase p_ functions/vars.
    return len(name) > 2 and name[:2] in ("p_", "P_")


# --------------------------------------------------------------------------- #
# Phase 1: ownership collection                                               #
# --------------------------------------------------------------------------- #

def _own(name: str, rel: str, stack: list[str], container: str, mp: ModuleOwners, cp: ClassOwners) -> None:
    if container == "class":
        cp.setdefault(name, set()).add((rel, stack[-1]))
    elif container == "module":
        mp.setdefault(name, set()).add(rel)
    # container == "function" -> local definition, not externally reachable


def _own_target(t: ast.AST, rel: str, stack: list[str], container: str, mp: ModuleOwners, cp: ClassOwners) -> None:
    if isinstance(t, ast.Name) and _is_p(t.id):
        _own(t.id, rel, stack, container, mp, cp)
    elif isinstance(t, ast.Attribute) and _is_p(t.attr):
        # self._x = ... / cls._x = ...: owned by the lexically enclosing class.
        if stack:
            cp.setdefault(t.attr, set()).add((rel, stack[-1]))
    elif isinstance(t, ast.Starred):
        _own_target(t.value, rel, stack, container, mp, cp)
    elif isinstance(t, (ast.Tuple, ast.List)):
        for elt in t.elts:
            _own_target(elt, rel, stack, container, mp, cp)


def _collect(node: ast.AST, rel: str, stack: list[str], container: str, mp: ModuleOwners, cp: ClassOwners) -> None:
    if isinstance(node, ast.ClassDef):
        if _is_p(node.name):
            _own(node.name, rel, stack, container, mp, cp)
        qual = f"{stack[-1]}.{node.name}" if stack else node.name
        for child in node.body:
            _collect(child, rel, [*stack, qual], "class", mp, cp)
        return
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
        if _is_p(node.name):
            _own(node.name, rel, stack, container, mp, cp)
        for child in node.body:
            _collect(child, rel, stack, "function", mp, cp)
        return
    if isinstance(node, (ast.Assign, ast.AnnAssign)):
        targets = node.targets if isinstance(node, ast.Assign) else [node.target]
        for t in targets:
            _own_target(t, rel, stack, container, mp, cp)
        return
    # Plain compound statements (if/for/while/with/try/...) keep the container so
    # a conditionally-defined member is still attributed to its real scope.
    for child in ast.iter_child_nodes(node):
        _collect(child, rel, stack, container, mp, cp)


# --------------------------------------------------------------------------- #
# Phase 2: reference checking                                                  #
# --------------------------------------------------------------------------- #

def _inline_ignored(lines: tuple[str, ...], lineno: int, name: str) -> bool:
    """True when the reported line carries a matching ``# p-private-ignore``."""
    if not (1 <= lineno <= len(lines)):
        return False
    m = _INLINE_IGNORE_RE.search(lines[lineno - 1])
    if not m:
        return False
    names = m.group("names")
    if not names:
        return True  # bare form silences any p-private finding on the line
    wanted = {n.strip() for n in names.replace(",", " ").split() if n.strip()}
    return name in wanted


def _emit(
    out: list[str], seen: set[tuple[int, int, str]], rel: str, node: ast.AST,
    name: str, msg: str, lines: tuple[str, ...],
) -> None:
    if _inline_ignored(lines, node.lineno, name):
        return
    key = (node.lineno, node.col_offset, msg)
    if key in seen:
        return
    seen.add(key)
    out.append(f"{rel}:{node.lineno}:{node.col_offset + 1}: error: [{RULE}] {msg}")


def _check_attr(
    node: ast.Attribute, rel: str, stack: list[str],
    mp: ModuleOwners, cp: ClassOwners, out: list[str], seen: set[tuple[int, int, str]],
    lines: tuple[str, ...],
) -> None:
    name = node.attr
    if name in cp:
        if cp[name] & {(rel, q) for q in stack}:
            return  # lexically inside an owning class -> legal
        owners = ", ".join(sorted(f"{q} ({r})" for r, q in cp[name]))
        _emit(out, seen, rel, node, name, f"class-private '{name}' accessed outside its class (owner: {owners})", lines)
        return
    if name in mp:
        if rel in mp[name]:
            return
        owners = ", ".join(sorted(mp[name]))
        _emit(out, seen, rel, node, name, f"module-private '{name}' accessed outside its file (defined in {owners})", lines)


def _check_import(
    name: str, node: ast.AST, rel: str,
    mp: ModuleOwners, out: list[str], seen: set[tuple[int, int, str]],
    lines: tuple[str, ...],
) -> None:
    if name in mp and rel not in mp[name]:
        owners = ", ".join(sorted(mp[name]))
        _emit(out, seen, rel, node, name, f"module-private '{name}' imported outside its file (defined in {owners})", lines)


def _check_refs(
    node: ast.AST, rel: str, stack: list[str],
    mp: ModuleOwners, cp: ClassOwners, out: list[str], seen: set[tuple[int, int, str]],
    lines: tuple[str, ...],
) -> None:
    if isinstance(node, ast.ClassDef):
        qual = f"{stack[-1]}.{node.name}" if stack else node.name
        # Decorators/bases are evaluated in the enclosing scope, not inside the class.
        for outer in (*node.decorator_list, *node.bases, *node.keywords):
            _check_refs(outer, rel, stack, mp, cp, out, seen, lines)
        for child in node.body:
            _check_refs(child, rel, [*stack, qual], mp, cp, out, seen, lines)
        return
    if isinstance(node, ast.Attribute) and isinstance(node.ctx, ast.Load) and _is_p(node.attr):
        _check_attr(node, rel, stack, mp, cp, out, seen, lines)
    elif isinstance(node, ast.ImportFrom):
        for alias in node.names:
            if alias.name != "*" and _is_p(alias.name):
                _check_import(alias.name, node, rel, mp, out, seen, lines)
    # A function does not open a new *class* scope, so the class stack is carried
    # through unchanged; that's why generic descent (not an early return) is right.
    for child in ast.iter_child_nodes(node):
        _check_refs(child, rel, stack, mp, cp, out, seen, lines)


# --------------------------------------------------------------------------- #
# Runner                                                                       #
# --------------------------------------------------------------------------- #

def run_p_private_check(
    root: Path,
    exceptions: dict[str, list[str]],
    excludes: list[str],
    ignores: dict[Path, set[str]] | None = None,
) -> list[str]:
    """Flag ``p_`` symbols accessed outside their owning file/class."""
    backend = root / "backend"
    if not backend.is_dir():
        return []

    # Parse once; phase 1 must see *every* file (even exempted ones) so ownership
    # is known when a non-exempt file reaches into them. The source lines are kept
    # so phase 2 can honor inline `# p-private-ignore` comments.
    trees: list[tuple[Path, str, ast.AST, tuple[str, ...]]] = []
    mp: ModuleOwners = {}
    cp: ClassOwners = {}
    for pyfile in sorted(backend.rglob("*.py")):
        if is_excluded(pyfile, root, excludes):
            continue
        rel = str(pyfile.relative_to(root))
        try:
            source = pyfile.read_text()
            tree = ast.parse(source, filename=rel)
        except (OSError, SyntaxError):
            continue
        trees.append((pyfile, rel, tree, tuple(source.splitlines())))
        for child in ast.iter_child_nodes(tree):
            _collect(child, rel, [], "module", mp, cp)

    # Phase 2 reports only for files that aren't exempted/lintignored.
    errors: list[str] = []
    for pyfile, rel, tree, lines in trees:
        if is_excepted(rel, RULE, exceptions):
            continue
        if ignores and is_lintignored(pyfile, root, RULE, ignores):
            continue
        seen: set[tuple[int, int, str]] = set()
        out: list[str] = []
        _check_refs(tree, rel, [], mp, cp, out, seen, lines)
        errors.extend(out)

    return errors
