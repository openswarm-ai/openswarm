#!/bin/bash
set -euo pipefail

# Master build script for the OpenSwarm desktop app.
#
# Steps:
#   1. Build the React frontend (webpack production build)
#   2. Set up the embedded Python environment
#   3. Package everything with electron-builder
#
# Output: electron/dist/OpenSwarm-<version>.dmg

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

echo "========================================"
echo "  OpenSwarm Desktop App Builder"
echo "========================================"
echo ""

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

# Skip code signing for local builds (set CSC_LINK for production signing)
export CSC_IDENTITY_AUTO_DISCOVERY=false

npx electron-builder --mac --publish never

echo ""
echo "========================================"
echo "  Build Complete!"
echo "========================================"
echo ""
echo "Output files:"
ls -lh "$PROJECT_ROOT/electron/dist/"*.zip 2>/dev/null || echo "  (no .zip found — check electron/dist/)"
echo ""
