"""Generate the doc-source tree from the repository (standalone pre-build step).

Zensical doesn't run MkDocs plugins (no ``mkdocs-gen-files`` / ``literate-nav``),
so instead of synthesizing virtual pages we write **real** Markdown files into
``content/`` before ``zensical build`` runs. Zensical then infers the navigation
from the directory structure, so the site still mirrors the codebase on every run.

Pure standard library — run it with any Python ≥3.9:

    python docs/gen_pages.py

Sources:
  1. ``backend/**/*.py``    -> ``content/reference/...``  (``::: module`` for mkdocstrings)
  2. repo Markdown          -> ``content/guides/...``     (READMEs + loose docs, verbatim)
  3. ``frontend/.typedoc``  -> ``content/frontend/...``   (TypeDoc output, if present)

The three generated directories are wiped and rebuilt each run; ``content/index.md``
(the hand-written landing page) is left untouched.
"""

from __future__ import annotations

import shutil
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent
DOCS_DIR = HERE / "content"

REFERENCE_DIR = DOCS_DIR / "reference"
GUIDES_DIR = DOCS_DIR / "guides"
FRONTEND_DIR = DOCS_DIR / "frontend"

# Directory names we never walk into when collecting Markdown.
SKIP_DIRS = {
    ".git", ".venv", "venv", "node_modules", "__pycache__", "site",
    ".pytest_cache", ".mypy_cache", "dist", "build", ".typedoc",
}


def _skipped(path: Path) -> bool:
    return any(part in SKIP_DIRS for part in path.parts)


def _write(dest: Path, text: str) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(text, encoding="utf-8")


def clean() -> None:
    for d in (REFERENCE_DIR, GUIDES_DIR, FRONTEND_DIR):
        if d.exists():
            shutil.rmtree(d)


# --- 1. Backend Python API -> mkdocstrings pages --------------------------

def gen_backend_reference() -> int:
    backend = REPO_ROOT / "backend"
    if not backend.is_dir():
        return 0
    count = 0
    for py in sorted(backend.rglob("*.py")):
        if _skipped(py):
            continue
        parts = list(py.relative_to(REPO_ROOT).with_suffix("").parts)  # backend, apps, ...
        is_package = parts[-1] == "__init__"
        if is_package:
            parts = parts[:-1]
        module = ".".join(parts)                     # e.g. backend.apps.export.snapshot
        rel = parts[1:]                              # drop the leading "backend" for a flatter nav

        if is_package:
            # Package → section landing page (works with navigation.indexes).
            dest = REFERENCE_DIR.joinpath(*rel, "index.md") if rel else REFERENCE_DIR / "index.md"
        else:
            dest = REFERENCE_DIR.joinpath(*rel).with_suffix(".md")

        # No hand-written H1: mkdocstrings renders the heading, and the nav label
        # is derived from the file/dir name (clean, short labels).
        _write(dest, f"::: {module}\n")
        count += 1
    return count


# --- 2. Repo Markdown (READMEs + loose docs) ------------------------------

def gen_guides() -> int:
    curated = [
        REPO_ROOT / "README.md",
        REPO_ROOT / "implementation_plan.md",
        REPO_ROOT / "relevant_context.md",
        REPO_ROOT / "frontend" / "DESIGN.md",
    ]
    nested_readmes = sorted(REPO_ROOT.rglob("README.md"))

    seen: set[Path] = set()
    count = 0
    for md in [*curated, *nested_readmes]:
        if not md.is_file() or md in seen or _skipped(md):
            continue
        if DOCS_DIR in md.parents:       # never re-ingest our own generated tree
            continue
        seen.add(md)

        rel = md.relative_to(REPO_ROOT)
        # Map the project root README to the Guides landing page.
        if rel == Path("README.md"):
            dest = GUIDES_DIR / "index.md"
        else:
            dest = GUIDES_DIR / rel
        _write(dest, md.read_text(encoding="utf-8"))
        count += 1
    return count


# --- 3. Frontend TypeDoc output -------------------------------------------

def gen_frontend() -> int:
    typedoc = REPO_ROOT / "frontend" / ".typedoc"
    if not typedoc.is_dir():
        return 0
    count = 0
    for md in sorted(typedoc.rglob("*.md")):
        rel = md.relative_to(typedoc)
        if any(p in SKIP_DIRS for p in rel.parts):
            continue
        _write(FRONTEND_DIR / rel, md.read_text(encoding="utf-8"))
        count += 1
    return count


def main() -> int:
    clean()
    n_api = gen_backend_reference()
    n_guides = gen_guides()
    n_front = gen_frontend()
    print(f"gen_pages: {n_api} API pages, {n_guides} guides, {n_front} frontend pages "
          f"written under {DOCS_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
