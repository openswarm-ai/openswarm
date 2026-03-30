#!/bin/bash
set -euo pipefail

# Master build script for the OpenSwarm desktop app.
#
# Usage:
#   bash run/utils/build-app.sh              Local dev build (unsigned)
#   bash run/utils/build-app.sh --publish    Production build (signed, notarized, published to GitHub Releases)

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

# Step 0: Ensure bundled uv/uvx binaries exist
UV_BIN_DIR="$PROJECT_ROOT/backend/apps/tools_lib/uv-bin"
if [[ ! -f "$UV_BIN_DIR/uvx" ]]; then
    echo "[0] Downloading uv/uvx binaries..."
    mkdir -p "$UV_BIN_DIR"
    TMPDIR_UV=$(mktemp -d)
    # Download both architectures and create universal binaries
    curl -sL "https://github.com/astral-sh/uv/releases/latest/download/uv-aarch64-apple-darwin.tar.gz" | tar xz -C "$TMPDIR_UV"
    curl -sL "https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-apple-darwin.tar.gz" | tar xz -C "$TMPDIR_UV"
    lipo -create "$TMPDIR_UV/uv-aarch64-apple-darwin/uv" "$TMPDIR_UV/uv-x86_64-apple-darwin/uv" -output "$UV_BIN_DIR/uv"
    lipo -create "$TMPDIR_UV/uv-aarch64-apple-darwin/uvx" "$TMPDIR_UV/uv-x86_64-apple-darwin/uvx" -output "$UV_BIN_DIR/uvx"
    chmod +x "$UV_BIN_DIR/uv" "$UV_BIN_DIR/uvx"
    rm -rf "$TMPDIR_UV"
    echo "uv/uvx downloaded and bundled."
else
    echo "[0] uv/uvx binaries already present."
fi
echo ""

# Step 1: Build frontend
echo "[1/5] Building frontend..."
cd "$PROJECT_ROOT/frontend"
npm install
npm run build

if [[ ! -f "$PROJECT_ROOT/frontend/dist/index.html" ]]; then
    echo "ERROR: Frontend build failed — dist/index.html not found"
    exit 1
fi
echo "Frontend build complete."
echo ""

# Step 2: Build Python environment
echo "[2/5] Building Python environment..."
bash "$SCRIPT_DIR/build-python-env.sh"

if [[ ! -d "$PROJECT_ROOT/electron/python-env" ]]; then
    echo "ERROR: Python environment not found at electron/python-env/"
    exit 1
fi
echo "Python environment ready."
echo ""

# Step 3: Build 9Router
echo "[3/5] Building 9Router..."
cd "$PROJECT_ROOT/9router"
npm install
npm run build

if [[ ! -d "$PROJECT_ROOT/9router/.next/standalone" ]]; then
    echo "ERROR: 9Router build failed — .next/standalone not found"
    exit 1
fi

# Copy static assets into standalone (required by Next.js standalone mode)
if [[ -d "$PROJECT_ROOT/9router/.next/static" ]]; then
    cp -r "$PROJECT_ROOT/9router/.next/static" "$PROJECT_ROOT/9router/.next/standalone/.next/static"
fi
if [[ -d "$PROJECT_ROOT/9router/public" ]]; then
    cp -r "$PROJECT_ROOT/9router/public" "$PROJECT_ROOT/9router/.next/standalone/public"
fi

echo "9Router build complete."
echo ""

# Step 4: Snapshot source directories for packaging
echo "[4/5] Snapshotting source directories..."
STAGING_DIR="$PROJECT_ROOT/electron/build-staging"
rm -rf "$STAGING_DIR"
mkdir -p "$STAGING_DIR"

cp "$PROJECT_ROOT/ports.config.json" "$STAGING_DIR/ports.config.json"

rsync -a \
    --exclude='__pycache__' --exclude='**/__pycache__' \
    --exclude='*.pyc' --exclude='.venv' \
    "$PROJECT_ROOT/backend/" "$STAGING_DIR/backend/"

rsync -a "$PROJECT_ROOT/frontend/dist/" "$STAGING_DIR/frontend/"

# 9Router — copy the pre-built standalone directory
rsync -a \
    "$PROJECT_ROOT/9router/.next/standalone/" "$STAGING_DIR/9router/"
# Copy the .next directory structure needed by standalone
mkdir -p "$STAGING_DIR/9router/.next"
if [[ -d "$PROJECT_ROOT/9router/.next/static" ]]; then
    rsync -a "$PROJECT_ROOT/9router/.next/static/" "$STAGING_DIR/9router/.next/static/"
fi

echo ""
printf '\033[1;42;97m%s\033[0m\n' "========================================"
printf '\033[1;42;97m%s\033[0m\n' "  ✅ SOURCE SNAPSHOT COMPLETE            "
printf '\033[1;42;97m%s\033[0m\n' "  It is now safe to modify your codebase."
printf '\033[1;42;97m%s\033[0m\n' "========================================"
echo ""

# Step 5: Package with electron-builder
echo "[5/5] Packaging with electron-builder..."
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

rm -rf "$PROJECT_ROOT/electron/build-staging"

echo ""
echo "========================================"
echo "  Build Complete!"
echo "========================================"
echo ""
echo "Output files:"
ls -lh "$PROJECT_ROOT/electron/dist/"*.dmg 2>/dev/null || true
ls -lh "$PROJECT_ROOT/electron/dist/"*.zip 2>/dev/null || true
echo ""
