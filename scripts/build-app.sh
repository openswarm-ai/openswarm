#!/bin/bash
set -euo pipefail

# Master build script for the OpenSwarm desktop app.
#
# Usage:
#   bash scripts/build-app.sh              Local dev build (unsigned)
#   bash scripts/build-app.sh --publish    Production build (signed, notarized, published to GitHub Releases)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

ENV_FILE="$PROJECT_ROOT/backend/.env"
if [[ -f "$ENV_FILE" ]]; then
    set -a
    source "$ENV_FILE"
    set +a
fi

PUBLISH_MODE=false
if [[ "${1:-}" == "--publish" ]]; then
    PUBLISH_MODE=true
fi

echo "========================================"
echo "  OpenSwarm Desktop App Builder"
if $PUBLISH_MODE; then
    echo "  Mode: PRODUCTION (sign + notarize + publish)"
else
    echo "  Mode: LOCAL (unsigned)"
fi
echo "========================================"
echo ""

if $PUBLISH_MODE; then
    missing_vars=()
    [[ -z "${APPLE_ID:-}" ]] && missing_vars+=("APPLE_ID")
    [[ -z "${APPLE_APP_SPECIFIC_PASSWORD:-}" ]] && missing_vars+=("APPLE_APP_SPECIFIC_PASSWORD")
    [[ -z "${APPLE_TEAM_ID:-}" ]] && missing_vars+=("APPLE_TEAM_ID")
    [[ -z "${GH_TOKEN:-}" ]] && missing_vars+=("GH_TOKEN")
    if [[ ${#missing_vars[@]} -gt 0 ]]; then
        echo "ERROR: Missing required environment variables for --publish mode:"
        printf '  - %s\n' "${missing_vars[@]}"
        echo ""
        echo "See script header for details."
        exit 1
    fi
fi

# Step 1: Build frontend
echo "[1/3] Building frontend..."
cd "$PROJECT_ROOT/frontend"
npm ci
npm run build

if [[ ! -f "$PROJECT_ROOT/frontend/dist/index.html" ]]; then
    echo "ERROR: Frontend build failed — dist/index.html not found"
    exit 1
fi
echo "Frontend build complete."
echo ""

# Step 2: Build Python environment
echo "[2/3] Building Python environment..."
bash "$SCRIPT_DIR/build-python-env.sh"

if [[ ! -d "$PROJECT_ROOT/electron/python-env" ]]; then
    echo "ERROR: Python environment not found at electron/python-env/"
    exit 1
fi
echo "Python environment ready."
echo ""

# Step 3: Package with electron-builder
echo "[3/3] Packaging with electron-builder..."
cd "$PROJECT_ROOT/electron"
npm install

if $PUBLISH_MODE; then
    npx electron-builder --mac --arm64 --x64 --publish always
else
    export CSC_IDENTITY_AUTO_DISCOVERY=false
    ARCH=$(uname -m)
    if [[ "$ARCH" == "arm64" ]]; then
        npx electron-builder --mac --arm64 --publish never
    elif [[ "$ARCH" == "x86_64" ]]; then
        npx electron-builder --mac --x64 --publish never
    else
        npx electron-builder --mac --publish never
    fi
fi

echo ""
echo "========================================"
echo "  Build Complete!"
echo "========================================"
echo ""
echo "Output files:"
ls -lh "$PROJECT_ROOT/electron/dist/"*.dmg 2>/dev/null || true
ls -lh "$PROJECT_ROOT/electron/dist/"*.zip 2>/dev/null || true
echo ""
