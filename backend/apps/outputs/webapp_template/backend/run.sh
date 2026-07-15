#!/bin/bash
# The comment above is shebang, DO NOT REMOVE
RUN_BACKEND_ABSPATH="$(readlink -f "${BASH_SOURCE[0]}")"
if [[ "$OSTYPE" == "darwin"* ]]; then
    # echo "In macOS server sed START"
    # echo "SERVER_ABSPATH: $SERVER_ABSPATH"
    sed -i '' 's/\r//g' "$RUN_BACKEND_ABSPATH"
    # echo "In macOS server sed END"
else
    # echo "NOT in macOS server START"
    # echo "SERVER_ABSPATH: $SERVER_ABSPATH"
    sed -i 's/\r//g' "$RUN_BACKEND_ABSPATH"
    # echo "NOT in macOS server START"
fi
chmod +x "$RUN_BACKEND_ABSPATH"

if [[ "${BACKEND_PORT}" == "NONE" ]]; then
    echo "BACKEND_PORT=NONE — backend disabled. Exiting."
    exit 0
fi

BACKEND_DIR_ABSPATH="$(dirname "$RUN_BACKEND_ABSPATH")"

# Windows (Git Bash / MSYS) reports OSTYPE=msys|cygwin|win32; venv layout
# is Scripts\ + python.exe, and the bare interpreter is `python` not
# `python3`. Branch once here so every later path is correct.
IS_WIN=0
case "$OSTYPE" in
    msys*|cygwin*|win32*) IS_WIN=1 ;;
esac

# --- Find a working Python 3 ---
# Prefer an explicit path the host passed us (OPENSWARM_PYTHON, set by the
# packaged Electron shell to the bundled standalone Python so a fresh
# Windows machine with no system Python still works). Fall back to PATH
# probing for dev. `python` is first on Windows since python3.x aliases
# usually don't exist there.
PYTHON=""
if [[ -n "${OPENSWARM_PYTHON:-}" ]] && "${OPENSWARM_PYTHON}" -c "import sys; sys.exit(0 if sys.version_info[0]==3 else 1)" &>/dev/null; then
    PYTHON="${OPENSWARM_PYTHON}"
else
    if [[ "$IS_WIN" == "1" ]]; then
        CANDIDATES="python python3 python3.13 python3.12 python3.11 python3.10"
    else
        CANDIDATES="python3.13 python3.12 python3.11 python3.10 python3 python"
    fi
    for candidate in $CANDIDATES; do
        if command -v "$candidate" &>/dev/null && "$candidate" -c "import sys; sys.exit(0 if sys.version_info[0]==3 else 1)" &>/dev/null; then
            PYTHON="$candidate"
            break
        fi
    done
fi
if [[ -z "$PYTHON" ]]; then
    echo "Error: No working Python 3 found."
    exit 1
fi
echo "Using Python: $PYTHON ($("$PYTHON" --version 2>&1))"

# --- Create virtual environment if it doesn't exist ---
VENV_DIR="$BACKEND_DIR_ABSPATH/.venv"
SENTINEL="$VENV_DIR/.openswarm_installed"

# Resolve the venv interpreter by OS layout instead of `source activate`,
# whose path (bin/ vs Scripts/) and shell semantics differ across
# platforms. Calling the venv python directly is portable and avoids the
# activate-script fork entirely.
if [[ "$IS_WIN" == "1" ]]; then
    VENV_PY="$VENV_DIR/Scripts/python.exe"
else
    VENV_PY="$VENV_DIR/bin/python"
fi

# Fast path on every restart: if .venv exists AND we've already
# installed the workspace's deps once, skip the entire venv-create +
# pip-install dance (saves ~25s per workspace cold-restart). The
# sentinel gets touched at the end of the install block; if any step
# failed we never wrote it, so the next run takes the slow path again
# and retries.
if [[ -d "$VENV_DIR" && -f "$SENTINEL" ]]; then
    echo "Dependencies already installed — skipping venv create + pip install."
else
    if [[ ! -d "$VENV_DIR" ]]; then
        echo "Creating virtual environment..."
        "$PYTHON" -m venv "$VENV_DIR"
        if [[ $? -ne 0 ]]; then
            echo "Error: Failed to create virtual environment."
            exit 1
        fi
    fi

    # --- Install Python dependencies ---
    echo "Installing dependencies..."
    cd "$BACKEND_DIR_ABSPATH"
    "$VENV_PY" -m pip install -e .
    if [[ $? -ne 0 ]]; then
        echo "Error: Failed to install Python dependencies."
        exit 1
    fi
    touch "$SENTINEL"
fi

# --- Start the backend server ---
# No --reload here: this is the user's generated workspace, not an
# OpenSwarm dev environment. The agent rewrites files whole-file
# during builds; uvicorn's WatchFiles supervisor would just tear down
# the running server every keystroke. When the agent explicitly wants
# the backend to pick up new code it can hit OpenSwarm's
# /api/outputs/workspace/{ws}/runtime/restart endpoint, which sends a
# clean SIGTERM and restarts via this same script.
# swarm-debug gates output on per-file toggles that default OFF; force all ON each boot so agent-added files show in the Terminal.
if [[ "$IS_WIN" == "1" ]]; then SWARM_DEBUG_BIN="$VENV_DIR/Scripts/swarm-debug.exe"; else SWARM_DEBUG_BIN="$VENV_DIR/bin/swarm-debug"; fi
( cd "$BACKEND_DIR_ABSPATH/.." && "$SWARM_DEBUG_BIN" toggle on --all >/dev/null 2>&1 ) || true

echo "Starting backend server on http://0.0.0.0:${BACKEND_PORT:-8324} ..."
cd "$BACKEND_DIR_ABSPATH/.."
"$VENV_PY" -m uvicorn backend.main:app --host 0.0.0.0 --port "${BACKEND_PORT:-8324}"
