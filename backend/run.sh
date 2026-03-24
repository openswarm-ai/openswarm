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

# --- Install custom debugger module if not already installed ---
DEBUGGER_DIR_ABSPATH="$PROJECT_ROOT_ABSPATH/debugger"
if ! pip3 show debug > /dev/null 2>&1; then
    echo "Installing debugger module..."
    cd "$DEBUGGER_DIR_ABSPATH"
    pip3 install -e .
    if [[ $? -ne 0 ]]; then
        echo "Failed to install debugger module."
        exit 1
    fi
fi

# --- Install Python dependencies ---
echo "Installing dependencies..."
cd "$BACKEND_DIR_ABSPATH"
pip3 install -r requirements.txt
if [[ $? -ne 0 ]]; then
    echo "Failed to install Python dependencies."
    exit 1
fi

# --- Start the backend server ---
echo "Starting backend server on http://0.0.0.0:8324 ..."
cd "$PROJECT_ROOT_ABSPATH"
python3 -m uvicorn backend.main:app --host 0.0.0.0 --port 8324 --reload \
    --reload-dir "$BACKEND_DIR_ABSPATH" \
    --reload-exclude '*.pyc'
