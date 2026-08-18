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

# An interpreter for the two stdlib-only jobs below (checking the warm
# cache, picking a port); any Python 3 will do (macOS's own /usr/bin/python3
# included). Prefer the one OpenSwarm hands run.sh (OPENSWARM_PYTHON) when
# this shell has it; an agent shell usually does not, so fall back to PATH —
# `python` first on Windows, where python3.x aliases usually don't exist.
# run.sh chooses the interpreter that actually runs the backend,
# independently of this.
PYTHON_GUARD="./backend/config/python_runtime_guard.py"
INIT_PY=""
INIT_CANDIDATES=()
if [[ -n "${OPENSWARM_PYTHON:-}" ]]; then
    INIT_CANDIDATES+=("$OPENSWARM_PYTHON")
fi
if [[ "$OSTYPE" == msys* || "$OSTYPE" == cygwin* || "$OSTYPE" == win32* ]]; then
    INIT_CANDIDATES+=(python python3)
else
    INIT_CANDIDATES+=(python3 python)
fi
for candidate in "${INIT_CANDIDATES[@]}"; do
    if command -v "$candidate" &>/dev/null && "$candidate" -c "import sys; sys.exit(0 if sys.version_info[0]==3 else 1)" &>/dev/null; then
        INIT_PY="$candidate"
        break
    fi
done
if [[ -z "$INIT_PY" ]]; then
    echo "ERROR: no Python 3 interpreter found on PATH (or in OPENSWARM_PYTHON)." >&2
    exit 1
fi

# Reuse the warm-cache backend venv if available; this skips the
# ~5s venv-create + ~20s pip-install in the workspace's backend/run.sh.
# The cache holds FastAPI + transitives pre-installed; the workspace's
# own editable install (`pip install -e .`) still runs once on first
# boot to register its egg-link, but completes in <1s since every dep
# is already satisfied. Only an OpenSwarm-owned, fully populated cache
# is copied, into a staging directory that becomes .venv only once the
# copy is complete; run.sh then proves the copied interpreter is the one
# that runs the backend and rebuilds the venv if it is not (the app's
# Python moved since the cache was built). After the copy, the activate
# script's VIRTUAL_ENV path is rewritten so `source .venv/bin/activate`
# resolves to the correct workspace path.
CACHE_ROOT="${OPENSWARM_BACKEND_VENV_CACHE:-}"
CACHE_VENV="$CACHE_ROOT/.venv"
if [[ -n "$CACHE_ROOT" && -e "$CACHE_ROOT" ]] && "$INIT_PY" -I "$PYTHON_GUARD" verify-cache "$CACHE_ROOT"; then
    echo "Reusing warm backend venv from $CACHE_VENV..."
    STAGED_VENV="$(mktemp -d "$HERE/backend/.venv.pending.XXXXXX")"
    if cp -aR "$CACHE_VENV"/. "$STAGED_VENV"/; then
        mv "$STAGED_VENV" ./backend/.venv
        NEW_VENV_ABS="$HERE/backend/.venv"
        ACTIVATE="$NEW_VENV_ABS/bin/activate"
        if [[ -f "$ACTIVATE" ]]; then
            if [[ "$OSTYPE" == "darwin"* ]]; then
                sed -i '' "s|^VIRTUAL_ENV=.*|VIRTUAL_ENV=\"$NEW_VENV_ABS\"|" "$ACTIVATE"
            else
                sed -i "s|^VIRTUAL_ENV=.*|VIRTUAL_ENV=\"$NEW_VENV_ABS\"|" "$ACTIVATE"
            fi
        fi
    else
        echo "Warm-cache copy failed; leaving the partial copy at $STAGED_VENV and letting run.sh build a fresh .venv." >&2
    fi
elif [[ -n "$CACHE_ROOT" && -e "$CACHE_ROOT" ]]; then
    echo "Skipping the warm backend venv at $CACHE_VENV (not a complete OpenSwarm-owned cache); run.sh will build a fresh .venv." >&2
fi

# Pick a free port. SO_REUSEADDR=0 means the kernel won't immediately
# recycle, so the small race between bind+close and the backend
# re-binding is harmless in practice.
PORT="$("$INIT_PY" -I -c "import socket
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
