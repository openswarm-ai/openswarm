# Product Analytics — Documentation

This site is **auto-generated from the codebase** and built with
[Zensical](https://zensical.org/). Nothing here is written by hand except this
landing page — every other page is generated from the sources below before each
build, so the docs stay in sync as the code changes.

Re-run `./docs/run.sh` (or `zensical serve -o` from `docs/` for a
live preview) to refresh.

## What's in here

- **reference** — one page per Python module under `backend/`, rendered from the
  module/class/function docstrings via mkdocstrings.
- **frontend** — TypeDoc reference for the React/TypeScript app under `frontend/`
  (present only when TypeDoc ran during generation).
- **guides** — every Markdown doc in the repo: the root `README`, nested
  `README.md` files, `implementation_plan.md`, `relevant_context.md`, and
  `frontend/DESIGN.md`.

## HTTP API

The interactive HTTP API reference is served by the backend itself — run it and
open **`/docs`** (FastAPI's built-in Swagger UI) or **`/redoc`**.

## How it works

`gen_pages.py` walks the repository on each build and writes real Markdown files
into `content/reference/`, `content/guides/`, and `content/frontend/`. Zensical then infers
the navigation from that directory tree. See `docs/README.md` for the full
layout and knobs.
