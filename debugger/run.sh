#!/bin/bash
# The comment above is functional DO NOT REMOVE

DEBUGGER_ABSPATH="$(readlink -f "${BASH_SOURCE[0]}")"
DEBUGGER_DIR_ABSPATH="$(dirname "$DEBUGGER_ABSPATH")"

if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' 's/\r//g' "$DEBUGGER_ABSPATH"
else
    sed -i 's/\r//g' "$DEBUGGER_ABSPATH"
fi
chmod +x "$DEBUGGER_ABSPATH"

cleanup() {
    printf "\033[36mCleaning up debugger...\033[0m\n"
    wait $!
}

# Set trap to call cleanup on script exit
trap cleanup EXIT

cd "$DEBUGGER_DIR_ABSPATH/debugger_gui"
npm install
npm start & until curl -s http://localhost:6970 > /dev/null; do
    sleep 1
done
cd "$DEBUGGER_DIR_ABSPATH/debugger_backend"

# colorize print to cyan
printf "\033[36mSetting up virtual environment...\033[0m\n"
python -m venv .venv
# Activate the Python virtual environment
if [[ "$OSTYPE" == "msys" || "$OSTYPE" == "win32" ]]; then
    # Windows
    source .venv/Scripts/activate
else
    # macOS/Linux
    source .venv/bin/activate
fi

# colorize print to cyan
printf "\033[36mInstalling Python dependencies...\033[0m\n"
pip install -r requirements.txt

cd "$DEBUGGER_DIR_ABSPATH"
printf "\033[36mStarting debugger server...\033[0m\n"
python -m debugger_backend.debugger_server

printf "\033[36mDeactivating Python virtual environment...\033[0m\n"
deactivate
