#!/bin/bash
# Build the pre-compressed webapp-template node_modules archive that gets
# bundled into signed releases. Backend code (_try_extract_bundled_archive
# in view_builder_templates.py) unpacks this on first-app create instead
# of running a live `npm install`, dropping cold-start ~22 s → ~3 s.
#
# Run this once before packaging (CI / publish.sh / publish-win.ps1).
# Local dev installs that skip this step transparently fall through to
# live `npm install`; the archive is purely an optimization.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
TEMPLATE_DIR="$PROJECT_ROOT/backend/apps/outputs/webapp_template"
OUT_DIR="$PROJECT_ROOT/backend/apps/outputs/webapp_template_cache"

if [[ ! -f "$TEMPLATE_DIR/frontend/package.json" ]]; then
    echo "ERROR: $TEMPLATE_DIR/frontend/package.json not found"
    echo "Run scripts/fetch-webapp-template.sh first to populate the template."
    exit 1
fi

# Tag the archive with a sha of package.json so a stale archive from a
# previous template version is automatically skipped at runtime (the
# backend's _bundled_archive_path_for() computes the same digest). The
# 12-char prefix mirrors view_builder_templates._warm_cache_digest().
if command -v shasum >/dev/null 2>&1; then
    PKG_DIGEST=$(shasum -a 256 "$TEMPLATE_DIR/frontend/package.json" | awk '{print substr($1,1,12)}')
elif command -v sha256sum >/dev/null 2>&1; then
    PKG_DIGEST=$(sha256sum "$TEMPLATE_DIR/frontend/package.json" | awk '{print substr($1,1,12)}')
else
    echo "ERROR: neither shasum nor sha256sum found on PATH"
    exit 1
fi
OUT_ARCHIVE="$OUT_DIR/node_modules.${PKG_DIGEST}.tar.gz"

# Work in a temp dir so a failed install can't corrupt the template tree.
WORK_DIR=$(mktemp -d -t openswarm-template-archive-XXXXXX)
trap "rm -rf '$WORK_DIR'" EXIT

echo "Building template node_modules archive..."
echo "  source : $TEMPLATE_DIR/frontend/"
echo "  digest : $PKG_DIGEST"
echo "  staging: $WORK_DIR"
echo "  output : $OUT_ARCHIVE"
echo ""

cp "$TEMPLATE_DIR/frontend/package.json" "$WORK_DIR/package.json"
if [[ -f "$TEMPLATE_DIR/frontend/package-lock.json" ]]; then
    cp "$TEMPLATE_DIR/frontend/package-lock.json" "$WORK_DIR/package-lock.json"
    cd "$WORK_DIR"
    echo "[npm] running npm ci..."
    npm ci --prefer-offline --no-audit --no-fund --loglevel=error
else
    cd "$WORK_DIR"
    echo "[npm] running npm install (no lockfile)..."
    npm install --prefer-offline --no-audit --no-fund --loglevel=error
fi

if [[ ! -d "$WORK_DIR/node_modules" ]]; then
    echo "ERROR: npm did not produce node_modules in $WORK_DIR"
    exit 1
fi

mkdir -p "$OUT_DIR"
echo ""
echo "[tar] compressing node_modules..."
# `tar -C "$WORK_DIR" node_modules` so the archive root is `node_modules/`,
# matching what _try_extract_bundled_archive expects when extracting into
# cache_dir.
tar -czf "$OUT_ARCHIVE" -C "$WORK_DIR" node_modules

ARCHIVE_SIZE=$(du -h "$OUT_ARCHIVE" | awk '{print $1}')
NM_FILES=$(find "$WORK_DIR/node_modules" -type f | wc -l | tr -d ' ')
echo ""
echo "Done."
echo "  archive   : $OUT_ARCHIVE"
echo "  size      : $ARCHIVE_SIZE"
echo "  files in  : $NM_FILES"
