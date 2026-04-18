#!/bin/bash
# The comment above is shebang, DO NOT REMOVE
DEV_ABSPATH="$(readlink -f "${BASH_SOURCE[0]}")"
if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' 's/\r//g' "$DEV_ABSPATH"
else
    sed -i 's/\r//g' "$DEV_ABSPATH"
fi
chmod +x "$DEV_ABSPATH"

PROJECT_ROOT_ABSPATH="$(dirname "$(dirname "$DEV_ABSPATH")")"
BACKEND_DIR_ABSPATH="$PROJECT_ROOT_ABSPATH/backend"
UV_BIN="$BACKEND_DIR_ABSPATH/uv-bin/uv"

cleanup() {
    echo "Shutting down..."
    cd - > /dev/null 2>&1
}
trap cleanup EXIT INT TERM

if [[ ! -f "$UV_BIN" ]]; then
    echo "ERROR: Bundled uv not found at $UV_BIN"
    echo "Run 'bash run/local.sh' to download it automatically."
    exit 1
fi

# --- Install/sync dependencies ---
echo "Installing dependencies..."
"$UV_BIN" sync --project "$BACKEND_DIR_ABSPATH"
if [[ $? -ne 0 ]]; then
    echo "Failed to install Python dependencies."
    exit 1
fi

# --- Read dev port from ports.config.json ---
BACKEND_PORT=$(python3 -c "import json; print(json.load(open('$PROJECT_ROOT_ABSPATH/ports.config.json'))['backend']['dev'])")

# --- Start the backend server ---
echo "Starting backend server on http://0.0.0.0:${BACKEND_PORT} ..."
cd "$PROJECT_ROOT_ABSPATH"
WATCHFILES_FORCE_POLLING=true "$UV_BIN" run --project "$BACKEND_DIR_ABSPATH" python -m uvicorn backend.main:app \
    --host 0.0.0.0 --port "$BACKEND_PORT" --reload \
    --reload-dir "$BACKEND_DIR_ABSPATH" \
    --reload-exclude '*.pyc'