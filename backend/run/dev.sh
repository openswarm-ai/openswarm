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
source "$(dirname "$DEV_ABSPATH")/_utils.sh"


PROJECT_ROOT_ABSPATH="$(dirname "$BACKEND_DIR_ABSPATH")"

# Cleanup function on exit
cleanup() {
    formatted_echo --yellow "Shutting down..."
    cd - > /dev/null 2>&1
}
trap cleanup EXIT INT TERM

# --- Create virtual environment if it doesn't exist ---
VENV_DIR="$BACKEND_DIR_ABSPATH/.venv"
if [[ ! -d "$VENV_DIR" ]]; then
    formatted_echo --green "Creating virtual environment..."
    python -m venv "$VENV_DIR"
fi
source "$VENV_DIR/bin/activate"

# --- Install custom debugger module if not already installed ---
DEBUGGER_DIR_ABSPATH="$PROJECT_ROOT_ABSPATH/debugger"
if ! pip show debug > /dev/null 2>&1; then
    formatted_echo --green "Installing debugger module..."
    cd "$DEBUGGER_DIR_ABSPATH"
    pip install -e .
    if [[ $? -ne 0 ]]; then
        formatted_error "Failed to install debugger module."
        exit 1
    fi
fi

# --- Install Python dependencies ---
formatted_echo --green "Installing dependencies..."
cd "$BACKEND_DIR_ABSPATH"
pip install -r requirements.txt
if [[ $? -ne 0 ]]; then
    formatted_error "Failed to install Python dependencies."
    exit 1
fi

# --- Start the backend server ---
formatted_echo --green "Starting backend server on http://0.0.0.0:8324 ..."
cd "$PROJECT_ROOT_ABSPATH"
python -m uvicorn backend.main:app --host 0.0.0.0 --port 8324 --reload \
    --reload-dir "$BACKEND_DIR_ABSPATH" \
    --reload-exclude '*.pyc'
