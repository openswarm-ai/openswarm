"""Generate the doc-source tree from the repository (standalone pre-build step).

Zensical doesn't run MkDocs plugins (no ``mkdocs-gen-files`` / ``literate-nav``),
so instead of synthesizing virtual pages we write **real** Markdown files into
``content/`` before ``zensical build`` runs. Zensical then infers the navigation
from the directory structure, so the sidebar mirrors the repo on every run.

Pure standard library — run it with any Python ≥3.9:

    python docs/gen_pages.py

The site structure mirrors the repository: **every top-level folder becomes a
sidebar section**, populated by whatever docs live under it. Root-level Markdown
(``README.md`` and friends) is grouped under a synthetic ``General`` section.

Sources are declared once in ``RULES`` (see below); the same engine discovers,
filters, and writes each of them:

  1. ``**/*.py`` in real packages  -> ``content/<pkg-path>/...``  (leaf modules use
     ``::: module`` for mkdocstrings; packages get a generated card-grid overview)
  2. repo Markdown                 -> ``content/<top-dir>/...``   (root-level .md -> ``content/general/``)
  3. ``frontend/.typedoc``         -> ``content/frontend/...``    (TypeDoc output, if present)

Discovery uses ``git ls-files`` so the generator inherits ``.gitignore`` for free
— virtualenvs (``backend/tests/.runner-venv``), caches, and build output never
leak in, and there's no denylist to keep patched. The set of generated files is
recorded in ``docs/.gen_manifest`` and removed on the next run, so cleanup is
precise. Hand-written content (``content/index.md`` and the ``assets`` /
``stylesheets`` / ``javascripts`` folders) is never touched.
"""

from __future__ import annotations

import ast
import logging
import shutil
import subprocess
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent
CONTENT = HERE / "content"

# Root-level Markdown is grouped here; TypeDoc output lands under the frontend
# folder section like any other source under ``frontend/``.
GENERAL_DIR = CONTENT / "general"
FRONTEND_DIR = CONTENT / "frontend"

# Record of everything we wrote last run, so we can clean precisely. Lives
# outside ``content/`` (the Zensical docs_dir) so it's never served, and is
# git-ignored via docs/.gitignore.
MANIFEST = HERE / ".gen_manifest"

# Hand-written / static content under ``content/`` that we must never delete.
PRESERVE = {"index.md", "assets", "stylesheets", "javascripts"}

# Top-level repo folders to never turn into sections. ``docs`` is this tool and
# its own generated output — ingesting it would be circular.
EXCLUDE_TOP_DIRS = {"docs"}

# Module path segments that never belong in the public API reference.
EXCLUDE_SEGMENTS = {"tests", "migrations", "webapp_template"}

# Only used by the rglob fallback when ``git ls-files`` is unavailable (e.g. a
# source tarball). Git's own ignore rules cover this and more in the normal path.
_FALLBACK_SKIP = {
    ".git", ".venv", "venv", "node_modules", "__pycache__", "site",
    ".pytest_cache", ".mypy_cache", "dist", "build", ".typedoc",
    ".runner-venv", ".ruff_cache",
}

log = logging.getLogger("gen_pages")


# --- File discovery -------------------------------------------------------

def tracked_files(root: Path, patterns: list[str]) -> list[Path]:
    """Return repository files matching ``patterns`` (git pathspecs).

    Uses ``git ls-files`` so ignored paths (venvs, caches, build output) are
    excluded for free. Falls back to a filtered ``rglob`` — with a loud warning
    — when ``root`` isn't a git checkout, since that path can surface files git
    would have hidden.
    """
    try:
        result = subprocess.run(
            ["git", "ls-files", "-z", "--", *patterns],
            cwd=root,
            capture_output=True,
            text=True,
            check=True,
        )
    except (FileNotFoundError, subprocess.CalledProcessError) as exc:
        log.warning(
            "git ls-files unavailable (%s); falling back to rglob — output may "
            "include files git would ignore", exc,
        )
        return _rglob_fallback(root, patterns)
    return [root / line for line in result.stdout.split("\0") if line]


def _rglob_fallback(root: Path, patterns: list[str]) -> list[Path]:
    results: list[Path] = []
    for pattern in patterns:
        base, _, glob = pattern.rpartition("/")
        start = root / base if base else root
        suffix = glob.replace("*", "")
        if not start.is_dir():
            continue
        for path in start.rglob(f"*{suffix}"):
            if path.is_file() and not _is_skipped(path.relative_to(root)):
                results.append(path)
    return results


def _is_skipped(rel: Path) -> bool:
    return any(part in _FALLBACK_SKIP for part in rel.parts)


# --- Filters / path mapping -----------------------------------------------

def is_documentable_top_dir(rel: Path) -> bool:
    """Whether ``rel`` lives under a top-level folder we turn into a section."""
    return bool(rel.parts) and rel.parts[0] not in EXCLUDE_TOP_DIRS


def is_reference_module(rel: Path) -> bool:
    """Whether a ``*.py`` file should become an API reference page.

    Excludes tests, migrations, and the app-builder scaffolding template, and
    requires every path segment to be a valid (non-private) module name — which
    also rejects junk like ``.runner-venv`` dotted paths in the fallback case.
    Importability (a complete ``__init__.py`` chain) is checked separately.
    """
    parts = rel.with_suffix("").parts
    if not is_documentable_top_dir(rel):
        return False
    if any(seg in EXCLUDE_SEGMENTS for seg in parts):
        return False
    for seg in parts:
        if seg == "__init__":
            continue
        if not seg.isidentifier():
            return False
        if seg.startswith("_") and not seg.startswith("__"):
            return False
    return True


def is_importable(py: Path) -> bool:
    """Whether ``py``'s package chain is complete enough for Griffe to collect it.

    mkdocstrings resolves a dotted identifier (``backend.apps.settings.settings``)
    by walking real packages, so every ancestor directory must contain an
    ``__init__.py``. Emitting a page for a module under an ``__init__``-less dir
    (a namespace package) makes ``zensical build`` fail hard with
    ``Could not collect '<module>'``, so we skip those instead.
    """
    dir_parts = py.relative_to(REPO_ROOT).parts[:-1]
    return all(
        (REPO_ROOT.joinpath(*dir_parts[:i]) / "__init__.py").exists()
        for i in range(1, len(dir_parts) + 1)
    )


def _is_package_dir(rel: Path) -> bool:
    """Whether ``rel``'s top-level folder is itself an importable package."""
    return bool(rel.parts) and (REPO_ROOT / rel.parts[0] / "__init__.py").exists()


def _module_parts(py: Path) -> list[str]:
    parts = list(py.relative_to(REPO_ROOT).with_suffix("").parts)
    if parts and parts[-1] == "__init__":
        parts = parts[:-1]
    return parts


# --- Source rules ---------------------------------------------------------

@dataclass(frozen=True)
class SourceRule:
    """One declarative source: discover files, map each to a dest, render text."""

    name: str
    discover: Callable[[], Iterable[Path]]
    dest: Callable[[Path], Path]
    render: Callable[[Path], str]


def _discover_reference() -> Iterable[Path]:
    skipped = 0
    for py in tracked_files(REPO_ROOT, ["*.py"]):
        rel = py.relative_to(REPO_ROOT)
        if py.suffix != ".py" or not is_reference_module(rel):
            continue
        if not is_importable(py):
            # Only flag the gap for folders that are otherwise API packages
            # (a real misconfig, like a missing __init__.py in backend/). Plain
            # tooling dirs that aren't packages at all are skipped silently.
            if _is_package_dir(rel):
                skipped += 1
                log.warning(
                    "skipping %s: no __init__.py in its package chain "
                    "(mkdocstrings can't collect it)", rel,
                )
            continue
        yield py
    if skipped:
        log.warning("skipped %d reference module(s) missing an __init__.py", skipped)


def _dest_reference(py: Path) -> Path:
    # Mirror the repo path under content/, so the top-level package becomes its
    # own sidebar section (e.g. backend/apps/foo.py -> content/backend/apps/foo.md).
    parts = _module_parts(py)
    if py.name == "__init__.py":
        # Package → section/sub-section landing page (works with navigation.indexes).
        return CONTENT.joinpath(*parts, "index.md")
    return CONTENT.joinpath(*parts).with_suffix(".md")


# Card icons for the generated package-overview grids (Material icon set, shipped
# with Zensical and enabled via the pymdownx.emoji config in zensical.toml).
_SUBPKG_ICON = ":material-folder:"
_MODULE_ICON = ":material-file-code:"


def _module_docstring(py: Path) -> str:
    """Return ``py``'s module-level docstring (stripped), or '' when absent.

    Parsed via ``ast`` so we never import project code (no side effects, no
    dependency on an importable environment). Unparseable files degrade to ''.
    """
    try:
        tree = ast.parse(py.read_text(encoding="utf-8"))
    except (OSError, SyntaxError):
        return ""
    return (ast.get_docstring(tree) or "").strip()


def _doc_summary(py: Path) -> str:
    """First line of ``py``'s docstring — the one-line card summary."""
    doc = _module_docstring(py)
    return doc.splitlines()[0].strip() if doc else ""


def _overview_children(pkg_dir: Path) -> tuple[list, list]:
    """Documentable children of ``pkg_dir`` as ``(subpackages, modules)``.

    Applies the same filters as discovery (``is_reference_module`` /
    ``is_importable``) so the overview only ever links to pages that actually
    get generated — no dead links to skipped tests, private modules, or
    ``__init__``-less namespace dirs.
    """
    subpackages: list[tuple[str, str, str]] = []
    modules: list[tuple[str, str, str]] = []
    for child in sorted(pkg_dir.iterdir()):
        if child.name == "__init__.py":
            continue
        if child.is_dir():
            init = child / "__init__.py"
            if not init.is_file():
                continue
            rel = init.relative_to(REPO_ROOT)
            if not is_reference_module(rel) or not is_importable(init):
                continue
            subpackages.append((child.name, f"{child.name}/index.md", _doc_summary(init)))
        elif child.suffix == ".py":
            rel = child.relative_to(REPO_ROOT)
            if not is_reference_module(rel) or not is_importable(child):
                continue
            modules.append((child.stem, f"{child.stem}.md", _doc_summary(child)))
    return subpackages, modules


def _card(icon: str, label: str, link: str, summary: str, kind: str) -> str:
    """One Material ``grid cards`` list item (icon + linked title + body)."""
    body = summary or kind
    return (
        f"-   {icon}{{ .lg .middle }} __[{label}]({link})__\n\n"
        f"    ---\n\n"
        f"    {body}"
    )


def _render_package_overview(py: Path) -> str:
    """Landing page for a package: a card grid of its subpackages and modules.

    Replaces the old bare ``::: package`` (which renders as an empty heading when
    the ``__init__.py`` has no docstring or members — the common case here). Any
    real package docstring is rendered as a lead paragraph above the grid.
    """
    parts = _module_parts(py)
    dotted = ".".join(parts)
    subpackages, modules = _overview_children(py.parent)

    out = [f"# {parts[-1]}", ""]
    if len(parts) > 1:
        out += [f"`{dotted}`", ""]

    pkg_doc = _module_docstring(py)
    if pkg_doc:
        out += [pkg_doc, ""]

    cards = [_card(_SUBPKG_ICON, n, link, s, "Subpackage") for n, link, s in subpackages]
    cards += [_card(_MODULE_ICON, n, link, s, "Module") for n, link, s in modules]

    if cards:
        out += ['<div class="grid cards" markdown>', ""]
        out.append("\n\n".join(cards))
        out += ["", "</div>"]
    else:
        out.append("_No documented submodules._")

    return "\n".join(out) + "\n"


def _render_reference(py: Path) -> str:
    # Packages become a card-grid overview of their contents; leaf modules defer
    # to mkdocstrings, which renders the heading from the docstring (the nav
    # label is derived from the file/dir name for clean, short labels).
    if py.name == "__init__.py":
        return _render_package_overview(py)
    return f"::: {'.'.join(_module_parts(py))}\n"


def _discover_guides() -> Iterable[Path]:
    for md in tracked_files(REPO_ROOT, ["*.md"]):
        if md.suffix != ".md":
            continue
        rel = md.relative_to(REPO_ROOT)
        # Nested under an excluded top dir (our own docs/ tree) → skip. Root-level
        # Markdown has its filename as parts[0], so it's never excluded here.
        if rel.parts[0] in EXCLUDE_TOP_DIRS:
            continue
        # Skip app-builder scaffolding — its docs describe generated apps, not
        # this project. (Test/migration READMEs are still legitimate guides.)
        if "webapp_template" in rel.parts:
            continue
        yield md


def _dest_guides(md: Path) -> Path:
    rel = md.relative_to(REPO_ROOT)
    if len(rel.parts) == 1:
        # Root-level Markdown is grouped under the synthetic "General" section.
        if rel.name == "README.md":
            return GENERAL_DIR / "index.md"
        return GENERAL_DIR / rel.name
    # Otherwise mirror the repo path so each doc lands in its folder's section.
    return CONTENT / rel


def _discover_frontend() -> Iterable[Path]:
    typedoc = REPO_ROOT / "frontend" / ".typedoc"
    if not typedoc.is_dir():
        return
    # TypeDoc output is untracked (regenerated by run.sh), so git can't see it;
    # walk it directly.
    for md in sorted(typedoc.rglob("*.md")):
        yield md


def _dest_frontend(md: Path) -> Path:
    typedoc = REPO_ROOT / "frontend" / ".typedoc"
    return FRONTEND_DIR / md.relative_to(typedoc)


def _read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


RULES: list[SourceRule] = [
    SourceRule("reference", _discover_reference, _dest_reference, _render_reference),
    SourceRule("guides", _discover_guides, _dest_guides, _read_text),
    SourceRule("frontend", _discover_frontend, _dest_frontend, _read_text),
]


# --- Engine ---------------------------------------------------------------

def _clean_previous() -> None:
    """Remove the files generated last run, per the manifest.

    Falls back to removing every generated section under ``content/`` (anything
    that isn't hand-written/static) when no manifest exists yet — e.g. the first
    run after adopting the manifest, or a manually deleted manifest.
    """
    if MANIFEST.exists():
        for line in MANIFEST.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            path = HERE / line
            if path.is_file():
                path.unlink()
        MANIFEST.unlink()
    elif CONTENT.is_dir():
        for child in CONTENT.iterdir():
            if child.name in PRESERVE:
                continue
            if child.is_dir():
                shutil.rmtree(child)
            elif child.is_file():
                child.unlink()
    _prune_empty_dirs(CONTENT)


def _prune_empty_dirs(root: Path) -> None:
    if not root.is_dir():
        return
    # Deepest-first so a dir emptied by pruning its children is itself removed.
    for sub in sorted(root.rglob("*"), key=lambda p: len(p.parts), reverse=True):
        if sub.is_dir() and not any(sub.iterdir()):
            sub.rmdir()


def _write(dest: Path, text: str) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    # Skip the rewrite when content is unchanged so ``zensical serve`` doesn't
    # see a spurious modification (faster, quieter live reloads).
    if dest.is_file() and dest.read_text(encoding="utf-8") == text:
        return
    dest.write_text(text, encoding="utf-8")


def _run_rule(rule: SourceRule, written: set[Path]) -> int:
    count = 0
    for src in rule.discover():
        dest = rule.dest(src)
        _write(dest, rule.render(src))
        written.add(dest)
        count += 1
    return count


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(name)s: %(message)s")
    _clean_previous()

    written: set[Path] = set()
    counts = {rule.name: _run_rule(rule, written) for rule in RULES}

    manifest_lines = sorted(str(p.relative_to(HERE)) for p in written)
    MANIFEST.write_text("\n".join(manifest_lines) + "\n", encoding="utf-8")

    summary = ", ".join(f"{n} {name}" for name, n in counts.items())
    log.info("wrote %s pages under %s", summary, CONTENT)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
