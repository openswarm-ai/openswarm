# docs

A self-contained, local-only documentation generator built with
[**Zensical**](https://zensical.org/) (the Material for MkDocs team's Rust-based
successor to MkDocs). It builds a static site that **mirrors the codebase** —
pages are generated from docstrings, READMEs, and the frontend source on every
run, so the docs stay in sync as the code changes. Same "drop-in folder, re-run
to refresh" spirit as `dependency-graph/`.

## Use it

```bash
./docs/run.sh            # build the site and open it
./docs/run.sh --serve    # live-reloading dev server (great while writing docstrings)
```

The first run creates an isolated `docs/.venv` and installs the doc tooling
there. Output lands in `docs/site/` (git-ignored).

## What it pulls in

| Source | Becomes (`content/…`) |
| --- | --- |
| `backend/**/*.py` docstrings | `reference/` — one [mkdocstrings](https://mkdocstrings.github.io/) page per module. |
| `frontend/src` (TSDoc) | `frontend/` — [TypeDoc](https://typedoc.org/) reference (best-effort; needs Node + one-time network). |
| Every `README.md`, `implementation_plan.md`, `relevant_context.md`, `frontend/DESIGN.md` | `guides/` — copied verbatim. |

Add a module or a README anywhere and it appears on the next run — Zensical
**infers the navigation from the directory tree**, so there's no nav to maintain.

## How it differs from a plain Zensical site

Zensical doesn't run MkDocs plugins (no `mkdocs-gen-files` / `mkdocs-literate-nav`).
So instead of generating pages inside the build, `gen_pages.py` runs **before** the
build as a plain script and writes **real Markdown files** into `content/reference/`,
`content/guides/`, and `content/frontend/`. Those three directories are wiped and rebuilt
each run and are git-ignored; only `content/index.md` is hand-written.

## Files

| file | role |
| --- | --- |
| `run.sh` | bootstraps the venv, runs TypeDoc, generates pages, builds/serves, opens the site. |
| `zensical.toml` | site config (theme, markdown extensions, mkdocstrings options). |
| `gen_pages.py` | the engine: walks the repo and writes the `content/` page tree (pure stdlib). |
| `content/index.md` | the one hand-written page (the landing page). |
| `.venv/`, `site/`, `content/{reference,guides,frontend}/` | generated, git-ignored. |

## Knobs

- **Docstring style**: `zensical.toml` → `[project.plugins.mkdocstrings.handlers.python.options]` → `docstring_style` (currently `google`).
- **Skip directories / featured loose docs**: `SKIP_DIRS` and the `curated` list in `gen_pages.py`.
- **Theme & navigation features**: `[project.theme]` in `zensical.toml`.
- **Markdown extensions**: the `[project.markdown_extensions.*]` tables.

## Notes

- The **HTTP API** reference is no longer baked into this site — Zensical can't run
  the Swagger plugin yet. Use FastAPI's built-in `/docs` (Swagger) or `/redoc`.
- mkdocstrings support in Zensical is **preliminary** (no cross-references/backlinks
  yet); the rest renders normally. Track progress at
  [zensical.org/docs/setup/extensions/mkdocstrings](https://zensical.org/docs/setup/extensions/mkdocstrings/).
- The site is a static snapshot — re-run `run.sh` to refresh.
