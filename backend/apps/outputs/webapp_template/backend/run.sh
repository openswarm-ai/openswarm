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

# --- Find a working Python 3 ---
PYTHON=""
for candidate in python3.13 python3.12 python3.11 python3.10 python3; do
    if command -v "$candidate" &>/dev/null && "$candidate" -c "print('ok')" &>/dev/null; then
        PYTHON="$candidate"
        break
    fi
done
if [[ -z "$PYTHON" ]]; then
    echo "Error: No working Python 3 found."
    exit 1
fi
echo "Using Python: $PYTHON ($($PYTHON --version 2>&1))"

# --- Create virtual environment if it doesn't exist ---
VENV_DIR="$BACKEND_DIR_ABSPATH/.venv"
if [[ ! -d "$VENV_DIR" ]]; then
    echo "Creating virtual environment..."
    "$PYTHON" -m venv "$VENV_DIR"
    if [[ $? -ne 0 ]]; then
        echo "Error: Failed to create virtual environment."
        exit 1
    fi
fi
source "$VENV_DIR/bin/activate"

# --- Install Python dependencies ---
echo "Installing dependencies..."
cd "$BACKEND_DIR_ABSPATH"
if [[ -n "${OPENSWARM_DEBUGGER_PATH:-}" && -d "$OPENSWARM_DEBUGGER_PATH" ]]; then
    echo "Installing OpenSwarm debugger (swarm_debug) from $OPENSWARM_DEBUGGER_PATH"
    pip install -e "$OPENSWARM_DEBUGGER_PATH"
fi
pip install -e .
if [[ $? -ne 0 ]]; then
    echo "Error: Failed to install Python dependencies."
    exit 1
fi

# --- Start the backend server ---
echo "Starting backend server on http://0.0.0.0:${BACKEND_PORT:-8324} ..."
cd "$BACKEND_DIR_ABSPATH/.."
python -m uvicorn backend.main:app --host 0.0.0.0 --port "${BACKEND_PORT:-8324}" --reload
