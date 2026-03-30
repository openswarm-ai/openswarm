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

# Cleanup function on exit
cleanup() {
    echo "Shutting down..."
    cd - > /dev/null 2>&1
}
trap cleanup EXIT INT TERM

# --- Find Python >= 3.10 ---
REQUIRED_PYTHON_MINOR=10
PYTHON_BIN=""
for candidate in python3.13 python3.12 python3.11 python3.10 python3; do
    if command -v "$candidate" &>/dev/null; then
        ver=$("$candidate" -c "import sys; print(sys.version_info.minor)" 2>/dev/null)
        if [[ -n "$ver" ]] && (( ver >= REQUIRED_PYTHON_MINOR )); then
            PYTHON_BIN="$(command -v "$candidate")"
            break
        fi
    fi
done

if [[ -z "$PYTHON_BIN" ]]; then
    echo "ERROR: Python >= 3.${REQUIRED_PYTHON_MINOR} is required but not found."
    echo "Install it with: brew install python@3.13"
    exit 1
fi

# --- Create virtual environment if it doesn't exist ---
VENV_DIR="$BACKEND_DIR_ABSPATH/.venv"
if [[ ! -d "$VENV_DIR" ]]; then
    echo "Creating virtual environment with $("$PYTHON_BIN" --version)..."
    "$PYTHON_BIN" -m venv "$VENV_DIR"
fi

# --- Verify the venv Python meets the minimum version ---
VENV_PYTHON="$VENV_DIR/bin/python3"
VENV_VER=$("$VENV_PYTHON" -c "import sys; print(sys.version_info.minor)" 2>/dev/null)
if [[ -z "$VENV_VER" ]] || (( VENV_VER < REQUIRED_PYTHON_MINOR )); then
    echo "Existing venv uses Python 3.${VENV_VER:-?}, need >= 3.${REQUIRED_PYTHON_MINOR}. Recreating..."
    rm -rf "$VENV_DIR"
    echo "Creating virtual environment with $("$PYTHON_BIN" --version)..."
    "$PYTHON_BIN" -m venv "$VENV_DIR"
fi

source "$VENV_DIR/bin/activate"

# --- Upgrade pip if outdated ---
pip3 install --upgrade pip --quiet

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