#!/bin/bash
# The comment above is shebang, DO NOT REMOVE
DEV_ABSPATH="$(readlink -f "${BASH_SOURCE[0]}")"
if [[ "$OSTYPE" == "darwin"* ]]; then
    # echo "In macOS server sed START"
    # echo "SERVER_ABSPATH: $SERVER_ABSPATH"
    sed -i '' 's/\r//g' "$DEV_ABSPATH"
    # echo "In macOS server sed END"
else
    # echo "NOT in macOS server START"
    # echo "SERVER_ABSPATH: $SERVER_ABSPATH"
    sed -i 's/\r//g' "$DEV_ABSPATH"
    # echo "NOT in macOS server START"
fi
chmod +x "$DEV_ABSPATH"

PROJECT_ROOT_ABSPATH="$(dirname "$(dirname "$DEV_ABSPATH")")"
BACKEND_DIR_ABSPATH="$PROJECT_ROOT_ABSPATH/backend"

# Cleanup function on exit
cleanup() {
    echo "Shutting down..."
    cd - > /dev/null 2>&1
}
trap cleanup EXIT INT TERM

# --- Create virtual environment if it doesn't exist ---
VENV_DIR="$BACKEND_DIR_ABSPATH/.venv"
if [[ ! -d "$VENV_DIR" ]]; then
    echo "Creating virtual environment..."
    python3 -m venv "$VENV_DIR"
fi
source "$VENV_DIR/bin/activate"

# --- Install Python dependencies ---
echo "Installing dependencies..."
cd "$BACKEND_DIR_ABSPATH"
pip3 install -r requirements.txt
if [[ $? -ne 0 ]]; then
    echo "Failed to install Python dependencies."
    exit 1
fi

# --- Start the backend server ---
# IMPORTANT: --reload-exclude must cover every path the running backend
# itself may WRITE to. Without this, the App Builder agent writing into
# a workspace's backend (e.g. backend/data/outputs_workspace/<ws>/backend/
# apps/chat/chat.py) triggers WatchFiles, which reloads uvicorn,
# which closes the agent's WebSocket mid-stream — visible to the user
# as the agent randomly "stopping" and needing a Resume.
#
# Caveat about uvicorn's pattern semantics: glob strings like `*/data/*`
# get matched via `Path.match`, which is RIGHT-anchored and doesn't
# match deep paths. Only `--reload-exclude` values that resolve to a
# real directory at config time get added to uvicorn's dir-exclude list
# (compared via `dir in path.parents`). So we pass ABSOLUTE paths to
# the dirs we want to exclude — those are the only patterns uvicorn's
# WatchFilesReload actually honors for "anywhere under this tree".
# Dev only: OPENSWARM_PORT lets a parallel worktree bind its own backend port instead of colliding on 8324. Packaged builds never set it.
BACKEND_PORT="${OPENSWARM_PORT:-8324}"
echo "Starting backend server on http://0.0.0.0:${BACKEND_PORT} ..."
cd "$PROJECT_ROOT_ABSPATH"

UVICORN_EXCLUDE_ARGS=(--reload-exclude '*.pyc')
for d in \
    "$BACKEND_DIR_ABSPATH/data" \
    "$BACKEND_DIR_ABSPATH/mcp-bundles" \
    "$BACKEND_DIR_ABSPATH/apps/outputs/webapp_template" \
; do
    if [[ -d "$d" ]]; then
        UVICORN_EXCLUDE_ARGS+=(--reload-exclude "$d")
    fi
done

# --reload is purely a dev-loop convenience — auto-restart on source
# edits. Useless for end users running the packaged DMG (no source to
# edit) and actively harmful: WatchFiles uses real fs handles, the
# reload supervisor adds a couple hundred MB of resident memory, and
# every reload tears down running agent WebSockets. Only enable it
# when the top-level run.sh has set OPENSWARM_DEV=1 (which the dev
# launcher does). Packaged builds leave it unset → fast, lean,
# single-process uvicorn.
if [[ "${OPENSWARM_DEV:-}" == "1" ]]; then
    echo "OPENSWARM_DEV=1 detected, running uvicorn with --reload."
    python3 -m uvicorn backend.main:app --host 0.0.0.0 --port "$BACKEND_PORT" --reload \
        --reload-dir "$BACKEND_DIR_ABSPATH" \
        "${UVICORN_EXCLUDE_ARGS[@]}"
else
    python3 -m uvicorn backend.main:app --host 0.0.0.0 --port "$BACKEND_PORT"
fi
