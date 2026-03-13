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


formatted_echo --green "Installing dependencies..."
cd "$FRONTEND_DIR_ABSPATH"
npm install

formatted_echo --green "Building with development mode..."
npm run dev

# exit back to the dir that we were in before
cd -