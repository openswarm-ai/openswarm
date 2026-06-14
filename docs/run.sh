#!/usr/bin/env bash
#
# Build the documentation site and open it. Drop-in, local-only — same spirit as
# dependency-graph/generate.sh. From the repo root (or anywhere), run:
#
#     ./docs/run.sh           # live-reloading dev server (default)
#     ./docs/run.sh --build   # one-time build + open instead
#
# Built with Zensical (the Material for MkDocs team's successor to MkDocs).
# Everything is isolated in docs/.venv.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$HERE")"
cd "$REPO_ROOT"

VENV="$HERE/.venv"
PY="$VENV/bin/python"
ZENSICAL="$VENV/bin/zensical"

# 1. Bootstrap an isolated venv for the doc tooling.
# Zensical/mkdocstrings need Python >= 3.10; pick the newest available.
pick_python() {
  for c in python3.13 python3.12 python3.11 python3.10 python3; do
    local bin
    bin="$(command -v "$c" 2>/dev/null)" || continue
    if "$bin" -c 'import sys; raise SystemExit(0 if sys.version_info[:2] >= (3, 10) else 1)' 2>/dev/null; then
      echo "$bin"; return 0
    fi
  done
  return 1
}

if [[ ! -x "$PY" ]]; then
  BOOT_PY="$(pick_python)" || {
    echo "docs: need Python >= 3.10 on PATH to build the docs" >&2
    exit 1
  }
  echo "docs: creating venv at $VENV (using $BOOT_PY)"
  "$BOOT_PY" -m venv "$VENV"
fi
echo "docs: installing/upgrading doc dependencies"
"$PY" -m pip install -q --upgrade pip
"$PY" -m pip install -q -r "$HERE/requirements.txt"

# 2. Generate frontend TypeDoc markdown (best-effort; needs node + network once).
if command -v npx >/dev/null 2>&1 && [[ -f "$REPO_ROOT/frontend/package.json" ]]; then
  echo "docs: generating frontend TypeDoc reference"
  ( cd "$REPO_ROOT/frontend" \
      && npx -y -p typedoc -p typedoc-plugin-markdown typedoc \
           --plugin typedoc-plugin-markdown \
           --entryPointStrategy expand \
           --readme none \
           --skipErrorChecking \
           --out .typedoc \
           src \
  ) >/dev/null 2>&1 || echo "docs: TypeDoc step failed/skipped; frontend section omitted" >&2
else
  echo "docs: npx/frontend not available; frontend section omitted" >&2
fi

# 3. Generate the doc-source tree from the codebase (pure stdlib; writes real files).
echo "docs: generating pages from the codebase"
"$PY" "$HERE/gen_pages.py"

# 4. Build (or serve) the site. Run from the config dir so relative paths resolve.
if [[ "${1:-}" == "--build" ]]; then
  echo "docs: building site"
  ( cd "$HERE" && "$ZENSICAL" build )

  INDEX="$HERE/site/index.html"
  echo "docs: built $INDEX"
  if   command -v open     >/dev/null 2>&1; then open     "$INDEX" || true
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$INDEX" || true
  else echo "docs: open $INDEX in a browser to view the site"
  fi
  exit 0
fi

# Default: live-reloading dev server.
exec sh -c "cd '$HERE' && exec '$ZENSICAL' serve -o"
