#!/bin/bash
# The comment above is shebang, DO NOT REMOVE
PUBLISH_ABSPATH="$(readlink -f "${BASH_SOURCE[0]}")"
if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' 's/\r//g' "$PUBLISH_ABSPATH"
else
    sed -i 's/\r//g' "$PUBLISH_ABSPATH"
fi
chmod +x "$PUBLISH_ABSPATH"

PROJECT_ROOT="$(dirname "$PUBLISH_ABSPATH")"
cd "$PROJECT_ROOT"

echo "Building and deploying to Firebase Hosting..."
bash scripts/build-app.sh --publish

cd -