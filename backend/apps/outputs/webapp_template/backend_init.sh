#!/usr/bin/env bash
# Enable a FastAPI backend for this App.
#
# Idempotent. The workspace is seeded frontend-only (no backend/ dir,
# BACKEND_PORT=NONE). Run this script when your App needs server-side
# code; it copies the master template's backend/ into the workspace
# and flips BACKEND_PORT in both .env files to a free port.
#
# After running this, run `bash restart.sh` so the runtime restarts
# with the new BACKEND_PORT and `bash run.sh` brings the backend up.

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

if [[ ! -f .env ]]; then
    echo "ERROR: .env not found at $HERE. Is this the workspace root?" >&2
    exit 1
fi

# Source .env so we know the current BACKEND_PORT and the path to the
# master template's backend/ (written by OpenSwarm at seed time).
set -a
source .env
set +a

if [[ "${BACKEND_PORT:-NONE}" != "NONE" ]]; then
    echo "Backend already enabled on port $BACKEND_PORT, nothing to do." >&2
    exit 0
fi

if [[ -d ./backend ]]; then
    echo "ERROR: ./backend/ already exists but BACKEND_PORT=NONE; your" >&2
    echo "       workspace is in an inconsistent state. Either delete" >&2
    echo "       ./backend/ and re-run, or set BACKEND_PORT manually." >&2
    exit 1
fi

# Resolve master template backend/ path. OPENSWARM_TEMPLATE_BACKEND_PATH
# is written into .env at seed time.
if [[ -z "${OPENSWARM_TEMPLATE_BACKEND_PATH:-}" ]]; then
    echo "ERROR: OPENSWARM_TEMPLATE_BACKEND_PATH not set in .env. This" >&2
    echo "       workspace was seeded by an older OpenSwarm; ask the" >&2
    echo "       App Builder to recreate it." >&2
    exit 1
fi

if [[ ! -d "$OPENSWARM_TEMPLATE_BACKEND_PATH" ]]; then
    echo "ERROR: master template backend dir not found at" >&2
    echo "       $OPENSWARM_TEMPLATE_BACKEND_PATH" >&2
    exit 1
fi

echo "Copying backend/ from $OPENSWARM_TEMPLATE_BACKEND_PATH..."
cp -R "$OPENSWARM_TEMPLATE_BACKEND_PATH" ./backend
chmod +x ./backend/run.sh

# Reuse the warm-cache backend venv if available; this skips the
# ~5s venv-create + ~20s pip-install in the workspace's backend/run.sh.
# The cache holds FastAPI + transitives pre-installed; the workspace's
# own editable install (`pip install -e .`) still runs once on first
# boot to register its egg-link, but completes in <1s since every dep
# is already satisfied. After we cp -aR the cache into the workspace,
# the activate script's VIRTUAL_ENV path is rewritten so `source
# .venv/bin/activate` resolves to the correct workspace path.
CACHE_VENV="${OPENSWARM_BACKEND_VENV_CACHE:-}/.venv"
if [[ -d "$CACHE_VENV" ]]; then
    echo "Reusing warm backend venv from $CACHE_VENV..."
    cp -aR "$CACHE_VENV" ./backend/.venv
    NEW_VENV_ABS="$HERE/backend/.venv"
    ACTIVATE="$NEW_VENV_ABS/bin/activate"
    if [[ -f "$ACTIVATE" ]]; then
        if [[ "$OSTYPE" == "darwin"* ]]; then
            sed -i '' "s|^VIRTUAL_ENV=.*|VIRTUAL_ENV=\"$NEW_VENV_ABS\"|" "$ACTIVATE"
        else
            sed -i "s|^VIRTUAL_ENV=.*|VIRTUAL_ENV=\"$NEW_VENV_ABS\"|" "$ACTIVATE"
        fi
    fi
fi

# Pick a free port. SO_REUSEADDR=0 means the kernel won't immediately
# recycle, so the small race between bind+close and the backend
# re-binding is harmless in practice.
PORT="$(python3 -c "import socket
s = socket.socket()
s.bind(('127.0.0.1', 0))
print(s.getsockname()[1])
s.close()")"

# sed-flip both .env and .env.example so an LLM reading either gets the
# same answer. macOS sed needs the '' arg for in-place edits.
if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' "s/^BACKEND_PORT=NONE/BACKEND_PORT=$PORT/" .env
    sed -i '' "s/^BACKEND_PORT=NONE/BACKEND_PORT=$PORT/" .env.example
else
    sed -i "s/^BACKEND_PORT=NONE/BACKEND_PORT=$PORT/" .env
    sed -i "s/^BACKEND_PORT=NONE/BACKEND_PORT=$PORT/" .env.example
fi

echo ""
echo "Backend enabled on port $PORT."
echo "Run 'bash restart.sh' to bring it up (restarts the app runtime)."
