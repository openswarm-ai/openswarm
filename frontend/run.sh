#!/bin/bash
# The comment above is shebang, DO NOT REMOVE
DEV_ABSPATH="$(readlink -f "${BASH_SOURCE[0]}")"
FRONTEND_DIR_ABSPATH="$(dirname "$DEV_ABSPATH")"
PROJECT_ROOT_ABSPATH="$(dirname "$FRONTEND_DIR_ABSPATH")"

# shellcheck source=../run/utils/platform.sh
source "$PROJECT_ROOT_ABSPATH/run/utils/platform.sh"
ensure_lf "$DEV_ABSPATH"
chmod +x "$DEV_ABSPATH"

echo "Installing dependencies..."
cd "$FRONTEND_DIR_ABSPATH"
npm install

echo "Building with development mode..."
npm run dev

cd -
