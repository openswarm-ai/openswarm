#!/bin/bash
# The comment above is shebang, DO NOT REMOVE
PUBLISH_ABSPATH="$(readlink -f "${BASH_SOURCE[0]}")"
if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' 's/\r//g' "$PUBLISH_ABSPATH"
else
    sed -i 's/\r//g' "$PUBLISH_ABSPATH"
fi
chmod +x "$PUBLISH_ABSPATH"

RUN_DIR_ROOT="$(dirname "$PUBLISH_ABSPATH")"
PROJECT_ROOT="$(dirname "$RUN_DIR_ROOT")"
cd "$PROJECT_ROOT"

echo "Running structural linter..."
if ! python3 "$PROJECT_ROOT/linter/lint.py" --root "$PROJECT_ROOT"; then
    echo ""
    echo "Publish blocked: linter found violations. Fix them or add exceptions in linter/config/config.json."
    exit 1
fi
echo ""

echo "Building and deploying to Firebase Hosting..."
bash run/utils/build-app.sh --publish

cd -