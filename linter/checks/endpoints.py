"""Orphaned endpoint detection — cross-references backend routes with usage.

Extracts all registered API routes from the backend (decorator and add_api_route
patterns) and checks whether each route's static path segments appear in the
frontend source or in other backend files (e.g. MCP servers that call endpoints
internally).  Routes with no matching reference anywhere are flagged.

Limitations (v1):
  - Routes that end with a path parameter (e.g. /{id}) and have no trailing
    static segment are skipped — they're too ambiguous to match.
  - WebSocket routes in main.py are not checked.
  - Backend-only endpoints (health checks, OAuth callbacks) should be excluded
    via the exceptions list or endpoint-ignore-routes in config.json.
"""

from __future__ import annotations

import fnmatch
import re
from pathlib import Path

from . import is_excepted

_DECORATOR_RE = re.compile(
    r"@(\w+)\.router\.\w+\(\s*[\"']([^\"']+)[\"']"
)
_ADD_ROUTE_RE = re.compile(
    r"(\w+)\.router\.add_api_route\(\s*[\"']([^\"']+)[\"']"
)
_SUBAPP_RE = re.compile(
    r"(\w+)\s*=\s*SubApp\(\s*[\"']([^\"']+)[\"']"
)
_FUNC_DEF_RE = re.compile(r"\s*(?:async\s+)?def\s+(\w+)")
_ADD_ROUTE_FUNC_RE = re.compile(r"add_api_route\([^,]+,\s*(?:\w+\.)*(\w+)")

_TEMPLATE_ASSIGN_RE = re.compile(
    r"""(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*`([^`]*)`"""
)
_STRING_ASSIGN_RE = re.compile(
    r"""(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(['"])(.*?)\2"""
)
_TEMPLATE_REF_RE = re.compile(r"\$\{(\w+)\}")


def _static_tail(route_path: str) -> str:
    """Return the trailing contiguous static segments of a route path.

    >>> _static_tail("/sessions/{id}/message")
    '/message'
    >>> _static_tail("/usage-summary")
    '/usage-summary'
    >>> _static_tail("/{id}")
    ''
    """
    parts = route_path.strip("/").split("/")
    tail: list[str] = []
    for part in reversed(parts):
        if part.startswith("{"):
            break
        tail.append(part)
    tail.reverse()
    return "/" + "/".join(tail) if tail else ""


def _resolve_frontend_vars(files: list[tuple[str, str]]) -> dict[str, str]:
    """Collect const/let/var string assignments across files and resolve refs.

    Handles patterns like:
        const API_BASE = "/api";
        const WORKSPACE_API = `${API_BASE}/outputs/workspace`;
    """
    raw: dict[str, str] = {}
    for _, text in files:
        for m in _STRING_ASSIGN_RE.finditer(text):
            raw.setdefault(m.group(1), m.group(3))
        for m in _TEMPLATE_ASSIGN_RE.finditer(text):
            raw.setdefault(m.group(1), m.group(2))
    resolved = dict(raw)
    for _ in range(5):
        changed = False
        for name, val in list(resolved.items()):
            new_val = _TEMPLATE_REF_RE.sub(
                lambda m: resolved.get(m.group(1), m.group(0)), val
            )
            if new_val != val:
                resolved[name] = new_val
                changed = True
        if not changed:
            break
    return resolved


def _expand_template_refs(text: str, resolved: dict[str, str]) -> str:
    """Replace ``${VAR}`` references in *text* with resolved values."""
    return _TEMPLATE_REF_RE.sub(
        lambda m: resolved.get(m.group(1), m.group(0)), text
    )


def _find_func_name(lines: list[str], decorator_idx: int) -> str:
    for j in range(decorator_idx + 1, min(decorator_idx + 5, len(lines))):
        m = _FUNC_DEF_RE.match(lines[j])
        if m:
            return m.group(1)
    return ""


def run_endpoint_check(
    root: Path,
    exceptions: dict[str, list[str]],
    ignore_routes: list[str] | None = None,
) -> list[str]:
    """Find backend API endpoints with no matching frontend or backend reference."""
    backend_dir = root / "backend"
    frontend_dir = root / "frontend" / "src"
    if not backend_dir.exists() or not frontend_dir.exists():
        return []

    _ignore_routes = ignore_routes or []
    var_to_name: dict[str, str] = {}
    for py in backend_dir.rglob("*.py"):
        if ".venv" in py.parts:
            continue
        for m in _SUBAPP_RE.finditer(py.read_text(errors="ignore")):
            var_to_name[m.group(1)] = m.group(2)

    routes: list[tuple[str, str, str, int, str]] = []

    for py in backend_dir.rglob("*.py"):
        if ".venv" in py.parts:
            continue
        text = py.read_text(errors="ignore")
        lines = text.splitlines()
        rel = str(py.relative_to(root))

        for i, line in enumerate(lines):
            m = _DECORATOR_RE.search(line)
            if m:
                var, path = m.group(1), m.group(2)
                name = var_to_name.get(var)
                if name:
                    func = _find_func_name(lines, i)
                    routes.append((name, path, rel, i + 1, func))

            m2 = _ADD_ROUTE_RE.search(line)
            if m2:
                var, path = m2.group(1), m2.group(2)
                name = var_to_name.get(var)
                if name:
                    fm = _ADD_ROUTE_FUNC_RE.search(line)
                    func = fm.group(1) if fm else ""
                    routes.append((name, path, rel, i + 1, func))

    frontend_files: list[tuple[str, str]] = []
    for ext in ("*.ts", "*.tsx"):
        for f in frontend_dir.rglob(ext):
            frontend_files.append((str(f.relative_to(root)), f.read_text(errors="ignore")))

    backend_files: list[tuple[str, str]] = []
    for py in backend_dir.rglob("*.py"):
        if ".venv" in py.parts:
            continue
        backend_files.append((str(py.relative_to(root)), py.read_text(errors="ignore")))

    resolved_vars = _resolve_frontend_vars(frontend_files)

    errors: list[str] = []
    for subapp_name, route_path, filepath, lineno, func_name in routes:
        if is_excepted(filepath, "endpoints", exceptions):
            continue

        full_path = f"{subapp_name}{route_path}"

        if any(fnmatch.fnmatch(full_path, p) for p in _ignore_routes):
            continue
        tail = _static_tail(route_path)

        if not tail:
            continue

        found = False
        for _fe_path, fe_text in frontend_files:
            expanded = _expand_template_refs(fe_text, resolved_vars)
            if full_path in expanded:
                found = True
                break
            if subapp_name in expanded and tail in expanded:
                found = True
                break

        if not found:
            for be_path, be_text in backend_files:
                if be_path == filepath:
                    continue
                if full_path in be_text:
                    found = True
                    break

        if not found:
            label = func_name or route_path
            errors.append(
                f"{filepath}:{lineno}:1: warning: "
                f"[endpoints] orphaned endpoint '{label}' "
                f"(/api/{full_path}) — no frontend or backend reference found"
            )

    return sorted(errors)
