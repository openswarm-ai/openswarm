"""Import-cycle detection: flags RUNTIME circular imports (a strongly-connected
component of more than one file).

Only module-load-time edges count, because those are the ones that can blow up
at import with a "cannot access before initialization" TDZ error:
  - Python: top-level (module-scope) imports.
  - JS/TS:  static `import ... from`, `export ... from`, side-effect `import`,
            and `require(...)`.

Deliberately ignored, since neither runs during module init so neither can
deadlock:
  - `import type` / `export type` (the bundler erases them).
  - dynamic `import(...)` (deferred into its own chunk).

That is exactly why the idiomatic Redux store<->hooks cycle, whose closing edge
is an `import type`, is correctly NOT flagged.

Resolution is intentionally lossy in the safe direction: an import that does not
resolve to a real file in the repo is dropped, so a missed edge can only hide a
cycle (false negative), never invent one (false positive that would redden CI).
"""

from __future__ import annotations

import ast
import os
import re
from pathlib import Path

from . import _matches_any, is_excluded, is_lintignored

_JS_EXTS = (".ts", ".tsx", ".js", ".jsx")

# `import|export [type] <stuff> from '<spec>'`. The optional `type` right after
# the keyword marks a type-only edge we skip; a `type` buried inside { } (inline)
# is treated as runtime, which is the conservative choice.
_FROM_RE = re.compile(
    r"\b(?P<kw>import|export)\b(?P<typ>\s+type\b)?"
    r"(?:[^;{}]|\{[^{}]*\})*?\bfrom\s*['\"](?P<spec>[^'\"]+)['\"]",
    re.S,
)
_SIDE_EFFECT_RE = re.compile(r"^\s*import\s+['\"](?P<spec>[^'\"]+)['\"]", re.M)
_REQUIRE_RE = re.compile(r"\brequire\s*\(\s*['\"](?P<spec>[^'\"]+)['\"]")
_BLOCK_COMMENT_RE = re.compile(r"/\*.*?\*/", re.S)


def _strip_js_comments(src: str) -> str:
    """Drop /* */ blocks and full-line // comments so a commented-out import
    can't fabricate an edge.  Only ever removes text, never adds, so it can't
    create a false cycle."""
    src = _BLOCK_COMMENT_RE.sub("", src)
    return "\n".join(
        "" if line.lstrip().startswith("//") else line
        for line in src.splitlines()
    )


def _module_name(fp: Path, root: Path) -> str:
    parts = list(fp.relative_to(root).with_suffix("").parts)
    if parts and parts[-1] == "__init__":
        parts = parts[:-1]
    return ".".join(parts)


def _py_edges(fp: Path, src: str, root: Path, mod_to_file: dict[str, Path]) -> set[Path]:
    try:
        tree = ast.parse(src, filename=str(fp))
    except SyntaxError:
        return set()
    out: set[Path] = set()

    def add(dotted: str) -> None:
        parts = dotted.split(".")
        while parts:  # longest known prefix wins
            cand = ".".join(parts)
            if cand in mod_to_file and mod_to_file[cand] != fp:
                out.add(mod_to_file[cand])
                return
            parts = parts[:-1]

    me = _module_name(fp, root)
    is_pkg = fp.name == "__init__.py"
    for node in tree.body:  # module scope only -> these are the load-time imports
        if isinstance(node, ast.Import):
            for alias in node.names:
                add(alias.name)
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                pkg_parts = me.split(".") if is_pkg else me.split(".")[:-1]
                up = node.level - 1
                base_parts = pkg_parts[: len(pkg_parts) - up] if up <= len(pkg_parts) else []
                full = ".".join([*base_parts, node.module] if node.module else base_parts)
            else:
                full = node.module or ""
            if not full:
                continue
            add(full)
            for alias in node.names:
                add(f"{full}.{alias.name}")
    return out


def _resolve_ts(spec: str, fp: Path, root: Path, aliases: dict[str, str], fileset: set[Path]) -> Path | None:
    base: Path | None = None
    for prefix, target in aliases.items():
        if spec.startswith(prefix):
            base = root / (target + spec[len(prefix):])
            break
    if base is None:
        if spec.startswith("."):
            base = fp.parent / spec
        else:
            return None  # bare package import, not our code
    base = Path(os.path.normpath(str(base)))
    candidates: list[Path] = []
    if base.suffix in _JS_EXTS:
        candidates.append(base)
    candidates += [Path(f"{base}{ext}") for ext in _JS_EXTS]
    candidates += [base / f"index{ext}" for ext in _JS_EXTS]
    for cand in candidates:
        if cand in fileset and cand != fp:
            return cand
    return None


def _ts_edges(fp: Path, src: str, root: Path, aliases: dict[str, str], fileset: set[Path]) -> set[Path]:
    src = _strip_js_comments(src)
    specs: list[str] = []
    for m in _FROM_RE.finditer(src):
        if m.group("typ"):  # `import type` / `export type` -> erased, no runtime edge
            continue
        specs.append(m.group("spec"))
    specs += [m.group("spec") for m in _SIDE_EFFECT_RE.finditer(src)]
    specs += [m.group("spec") for m in _REQUIRE_RE.finditer(src)]
    out: set[Path] = set()
    for spec in specs:
        tgt = _resolve_ts(spec, fp, root, aliases, fileset)
        if tgt:
            out.add(tgt)
    return out


def _sccs(graph: dict[Path, set[Path]]) -> list[list[Path]]:
    """Tarjan's SCC, iterative so a deep import chain can't overflow the stack."""
    index: dict[Path, int] = {}
    low: dict[Path, int] = {}
    on_stack: set[Path] = set()
    stack: list[Path] = []
    result: list[list[Path]] = []
    counter = 0
    for root_node in list(graph):
        if root_node in index:
            continue
        work: list[tuple[Path, object]] = [(root_node, iter(graph.get(root_node, ())))]
        index[root_node] = low[root_node] = counter
        counter += 1
        stack.append(root_node)
        on_stack.add(root_node)
        while work:
            v, it = work[-1]
            descended = False
            for w in it:  # type: ignore[assignment]
                if w not in index:
                    index[w] = low[w] = counter
                    counter += 1
                    stack.append(w)
                    on_stack.add(w)
                    work.append((w, iter(graph.get(w, ()))))
                    descended = True
                    break
                if w in on_stack:
                    low[v] = min(low[v], index[w])
            if descended:
                continue
            if low[v] == index[v]:
                comp: list[Path] = []
                while True:
                    w = stack.pop()
                    on_stack.discard(w)
                    comp.append(w)
                    if w == v:
                        break
                if len(comp) > 1:
                    result.append(comp)
            work.pop()
            if work:
                low[work[-1][0]] = min(low[work[-1][0]], low[v])
    return result


def run_cycle_check(
    root: Path,
    excludes: list[str],
    aliases: dict[str, str],
    exceptions: dict[str, list[str]],
    ignores: dict[Path, set[str]],
) -> list[str]:
    files: list[Path] = []
    for dirpath, dirnames, filenames in os.walk(root):
        dp = Path(dirpath)
        if is_excluded(dp, root, excludes):
            dirnames.clear()
            continue
        for fname in filenames:
            fp = dp / fname
            if (fp.suffix == ".py" or fp.suffix in _JS_EXTS) and not is_excluded(fp, root, excludes):
                files.append(fp)

    fileset = set(files)
    mod_to_file = {_module_name(p, root): p for p in files if p.suffix == ".py"}

    graph: dict[Path, set[Path]] = {}
    for fp in files:
        try:
            src = fp.read_text(errors="ignore")
        except OSError:
            continue
        if fp.suffix == ".py":
            edges = _py_edges(fp, src, root, mod_to_file)
        else:
            edges = _ts_edges(fp, src, root, aliases, fileset)
        if edges:
            graph[fp] = edges

    patterns = exceptions.get("import-cycles", [])
    errors: list[str] = []
    for comp in _sccs(graph):
        members = sorted(str(p.relative_to(root)) for p in comp)
        if any(_matches_any(m, patterns) for m in members):
            continue
        if any(is_lintignored(p, root, "import-cycles", ignores) for p in comp):
            continue
        anchor = members[0]
        errors.append(
            f"{anchor}:1:1: error: "
            f"[import-cycles] Circular import ({len(members)} files): {', '.join(members)}"
        )
    return errors
