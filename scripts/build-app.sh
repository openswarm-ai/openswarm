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
SIGN_MODE=false
if [[ "${1:-}" == "--publish" ]]; then
    PUBLISH_MODE=true
    SIGN_MODE=true
elif [[ "${1:-}" == "--sign" ]]; then
    SIGN_MODE=true
fi

# Defensive: detach any leftover OpenSwarm DMG volumes from prior failed builds.
# hdiutil's "Resource busy" / volume-name-collision errors almost always trace
# back to a stale mount in /Volumes (e.g. after a build crash or a still-open
# Finder window from the last run).
shopt -s nullglob
for vol in /Volumes/OpenSwarm*; do
    if [[ -d "$vol" ]]; then
        echo "Detaching leftover DMG mount: $vol"
        hdiutil detach -force "$vol" 2>/dev/null || hdiutil detach "$vol" 2>/dev/null || true
    fi
done
shopt -u nullglob

echo "========================================"
echo "  OpenSwarm Desktop App Builder"
if $PUBLISH_MODE; then
    echo "  Mode: PRODUCTION (sign + notarize + publish)"
elif $SIGN_MODE; then
    echo "  Mode: SIGNED (sign + notarize, no publish)"
else
    echo "  Mode: LOCAL (unsigned)"
fi
echo "========================================"
echo ""

if $SIGN_MODE; then
    missing_vars=()
    [[ -z "${APPLE_ID:-}" ]] && missing_vars+=("APPLE_ID")
    [[ -z "${APPLE_APP_SPECIFIC_PASSWORD:-}" ]] && missing_vars+=("APPLE_APP_SPECIFIC_PASSWORD")
    [[ -z "${APPLE_TEAM_ID:-}" ]] && missing_vars+=("APPLE_TEAM_ID")
    if $PUBLISH_MODE; then
        [[ -z "${GH_TOKEN:-}" ]] && missing_vars+=("GH_TOKEN")
    fi
    if [[ ${#missing_vars[@]} -gt 0 ]]; then
        echo "ERROR: Missing required environment variables:"
        printf '  - %s\n' "${missing_vars[@]}"
        echo ""
        echo "See script header for details."
        exit 1
    fi
fi

# Step 0: Ensure bundled uv + uvx binaries exist.
# IMPORTANT: uvx is a tiny ~700KB shim that just resolves to a sibling `uv`
# binary on disk. It does NOT contain the package-installer logic itself;
# at runtime `uvx` errors with "Could not find the `uv` binary at either of:
# .../uv-bin/uv  .../uv-bin/uv" if `uv` is missing. So we must ship both,
# even though only Google Workspace MCP uses uvx as its `command`. A prior
# revision tried to save ~30MB by shipping only uvx — that broke MCP boot
# on fresh Macs. Don't repeat the mistake.
UV_BIN_DIR="$PROJECT_ROOT/backend/uv-bin"
mkdir -p "$UV_BIN_DIR"
NEED_UV=false
[[ ! -f "$UV_BIN_DIR/uv"  ]] && NEED_UV=true
[[ ! -f "$UV_BIN_DIR/uvx" ]] && NEED_UV=true
if $NEED_UV; then
    # Pinned uv version. "latest" used to mean a fresh uv could appear in any
    # build with zero warning, breaking reproducibility (pillar 3). Override
    # with UV_VERSION when deliberately bumping; keep Windows
    # (build-app-win.ps1) in lockstep. 0.11.16 is what "latest" resolved to
    # when this was pinned.
    UV_VERSION="${UV_VERSION:-0.11.16}"
    echo "[0] Downloading uv + uvx $UV_VERSION binaries (universal arm64+x64)..."
    TMPDIR_UV=$(mktemp -d)
    curl -sL "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-aarch64-apple-darwin.tar.gz" | tar xz -C "$TMPDIR_UV"
    curl -sL "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-x86_64-apple-darwin.tar.gz"  | tar xz -C "$TMPDIR_UV"
    lipo -create "$TMPDIR_UV/uv-aarch64-apple-darwin/uv"  "$TMPDIR_UV/uv-x86_64-apple-darwin/uv"  -output "$UV_BIN_DIR/uv"
    lipo -create "$TMPDIR_UV/uv-aarch64-apple-darwin/uvx" "$TMPDIR_UV/uv-x86_64-apple-darwin/uvx" -output "$UV_BIN_DIR/uvx"
    chmod +x "$UV_BIN_DIR/uv" "$UV_BIN_DIR/uvx"
    rm -rf "$TMPDIR_UV"
    echo "uv + uvx downloaded and bundled."
else
    echo "[0] uv + uvx already present."
fi
echo ""

# Step 0a: Sync the splash icon. electron-builder excludes `build/` from
# the shipped asar (it's the icon-source directory used to generate .icns/.ico),
# so the splash window can't read build/icon.png at runtime. We keep a copy
# at electron/splash/icon.png which IS shipped. See electron/main.js comment
# at iconPngPath for context.
cp "$PROJECT_ROOT/electron/build/icon.png" "$PROJECT_ROOT/electron/splash/icon.png"

# Step 0b: Bundle npm MCP servers via esbuild
# Each bundle compiles down to a single ~5-15 MB CommonJS file under
# backend/mcp-bundles/, runs on Electron's bundled Node at runtime
# (ELECTRON_RUN_AS_NODE=1), and is preferred by tools_lib.py:521 over
# any pre-installed node_modules tree. Bundling instead of shipping
# node_modules cuts the installer file count from ~28k -> ~9k, the
# dominant lever on NSIS install time + Defender scan cost.
MCP_BUNDLE_DIR="$PROJECT_ROOT/backend/mcp-bundles"
mkdir -p "$MCP_BUNDLE_DIR"

# Single-file CJS bundles. Output path is mcp-bundles/<output>.js. Use for
# packages that don't read sibling files at runtime. The import.meta.url
# polyfill is applied uniformly because nearly every modern ESM package
# uses createRequire(import.meta.url) somewhere in its dependency tree —
# without the polyfill, esbuild's ESM->CJS transform leaves import.meta.url
# as undefined and the bundle crashes at module load.
build_mcp_bundle_single() {
    local pkg_name="$1"
    local entry_subpath="$2"
    local output_name="$3"
    local out_file="$MCP_BUNDLE_DIR/$output_name"
    if [[ -f "$out_file" && -z "${OPENSWARM_REBUILD_BUNDLES:-}" ]]; then
        echo "[0b] $pkg_name bundle already present (set OPENSWARM_REBUILD_BUNDLES=1 to force rebuild)."
        return
    fi
    echo "[0b] Bundling $pkg_name -> $output_name ..."
    local tmp_dir; tmp_dir=$(mktemp -d)
    (
        cd "$tmp_dir"
        npm install "$pkg_name" --silent 2>/dev/null
        local entry="node_modules/$entry_subpath"
        if [[ ! -f "$entry" ]]; then echo "ERROR: $pkg_name entry not found at $entry" >&2; exit 1; fi
        local banner='const __OPENSWARM_IMPORT_META_URL__ = require("url").pathToFileURL(__filename).href;'
        npx esbuild "$entry" --bundle --platform=node --format=cjs --target=node22 --legal-comments=none \
            --define:import.meta.url=__OPENSWARM_IMPORT_META_URL__ \
            "--banner:js=$banner" \
            --outfile="$out_file"
    )
    rm -rf "$tmp_dir"
    echo "$pkg_name bundled ($(du -h "$out_file" | cut -f1))."
}

# Multi-file bundle. Output is a directory mcp-bundles/<dir>/ that mirrors the
# upstream SDK's "package_root/dist/index.js + ../package.json" layout. Use this
# for packages whose source reads __dirname/../package.json (for --version) or
# other sibling data files (e.g. @softeria/ms-365-mcp-server reads endpoints.json).
# `extras` is a space-separated list of "src=dst" pairs relative to node_modules
# and the bundle dir respectively (e.g. "@softeria/ms-365-mcp-server/dist/endpoints.json=dist/endpoints.json").
# `external` is a comma-separated list of npm package names to leave unbundled
# (e.g. "keytar" — the SDK gracefully degrades when keytar can't be imported).
build_mcp_bundle_dir() {
    local pkg_name="$1"
    local entry_subpath="$2"
    local out_dir_name="$3"
    local extras="$4"      # e.g. "@softeria/ms-365-mcp-server/dist/endpoints.json=dist/endpoints.json"
    local external="$5"    # comma-separated package names
    local out_dir="$MCP_BUNDLE_DIR/$out_dir_name"
    if [[ -f "$out_dir/dist/index.js" && -z "${OPENSWARM_REBUILD_BUNDLES:-}" ]]; then
        echo "[0b] $pkg_name bundle dir already present."
        return
    fi
    echo "[0b] Bundling $pkg_name -> $out_dir_name/ ..."
    local tmp_dir; tmp_dir=$(mktemp -d)
    rm -rf "$out_dir"
    mkdir -p "$out_dir/dist"
    (
        cd "$tmp_dir"
        npm install "$pkg_name" --silent 2>/dev/null
        local entry="node_modules/$entry_subpath"
        if [[ ! -f "$entry" ]]; then echo "ERROR: $pkg_name entry not found at $entry" >&2; exit 1; fi

        # Stripped sibling package.json — the SDK reads packageJson.version.
        # Critically OMIT "type":"module" so Node treats the CJS bundle correctly.
        local sdk_version
        sdk_version=$(node -e "console.log(require('./node_modules/$pkg_name/package.json').version)")
        printf '{"name":"%s","version":"%s"}' "$pkg_name" "$sdk_version" > "$out_dir/package.json"

        # Copy any sibling data files the SDK reads at runtime
        if [[ -n "$extras" ]]; then
            for pair in $extras; do
                local src="${pair%%=*}"
                local dst="${pair##*=}"
                mkdir -p "$(dirname "$out_dir/$dst")"
                cp "node_modules/$src" "$out_dir/$dst"
            done
        fi

        # Banner polyfills `require` for the import.meta.url polyfill.
        local banner='const __OPENSWARM_IMPORT_META_URL__ = require("url").pathToFileURL(__filename).href;'

        local external_args=""
        if [[ -n "$external" ]]; then
            # Portable comma-split (works in bash and zsh) — `read -ra` is bash-only.
            local _old_ifs="$IFS"
            IFS=','
            local ext
            for ext in $external; do external_args="$external_args --external:$ext"; done
            IFS="$_old_ifs"
        fi

        npx esbuild "$entry" --bundle --platform=node --format=cjs --target=node22 --legal-comments=none \
            --define:import.meta.url=__OPENSWARM_IMPORT_META_URL__ \
            "--banner:js=$banner" \
            $external_args \
            --outfile="$out_dir/dist/index.js"
    )
    rm -rf "$tmp_dir"
    echo "$pkg_name bundled ($(du -sh "$out_dir" | cut -f1))."
}

build_mcp_bundle_single 'reddit-mcp-buddy'             'reddit-mcp-buddy/dist/index.js'             'reddit-mcp-buddy.js'
build_mcp_bundle_dir    '@notionhq/notion-mcp-server'  '@notionhq/notion-mcp-server/bin/cli.mjs' \
                        'notionhq-notion-mcp-server' \
                        '@notionhq/notion-mcp-server/scripts/notion-openapi.json=scripts/notion-openapi.json' \
                        ''
build_mcp_bundle_dir    '@softeria/ms-365-mcp-server'  '@softeria/ms-365-mcp-server/dist/index.js' \
                        'softeria-ms-365-mcp-server' \
                        '@softeria/ms-365-mcp-server/dist/endpoints.json=dist/endpoints.json' \
                        'keytar'

# Wipe the legacy single-file Notion bundle if the dir bundle now supersedes it.
if [[ -f "$MCP_BUNDLE_DIR/notionhq-notion-mcp-server.js" && -d "$MCP_BUNDLE_DIR/notionhq-notion-mcp-server" ]]; then
    rm -f "$MCP_BUNDLE_DIR/notionhq-notion-mcp-server.js"
fi

# Defensively wipe any legacy npm-servers/ tree from prior builds so it
# doesn't ride along into the installer (would re-introduce ~19k files).
LEGACY_NPM_SERVERS="$PROJECT_ROOT/backend/npm-servers"
if [[ -d "$LEGACY_NPM_SERVERS" ]]; then
    echo "[0b] Removing legacy backend/npm-servers/ (superseded by mcp-bundles)..."
    rm -rf "$LEGACY_NPM_SERVERS"
fi
echo ""

# Step 1: Build frontend
echo "[1/4] Building frontend..."
cd "$PROJECT_ROOT/frontend"
# npm ci (not install): installs exactly what package-lock.json pins, never
# silently mutates the lock, and fails loudly on any drift. Reproducible builds
# (pillar 3) depend on the lock being boss.
npm ci
npm run build

if [[ ! -f "$PROJECT_ROOT/frontend/dist/index.html" ]]; then
    echo "ERROR: Frontend build failed — dist/index.html not found"
    exit 1
fi
echo "Frontend build complete."
echo ""

# Step 2: Build Python environment
echo "[2/4] Building Python environment..."
bash "$SCRIPT_DIR/build-python-env.sh"

if [[ ! -d "$PROJECT_ROOT/electron/python-env" ]]; then
    echo "ERROR: Python environment not found at electron/python-env/"
    exit 1
fi
echo "Python environment ready."
echo ""

# Step 3: Fetch Router from npm
# The 9router Next.js server is published as an npm package with a pre-built
# standalone output. We install it into a scratch dir and stage it directly
# rather than vendoring the source + rebuilding here.
echo "[3/5] Fetching Router from npm..."
STAGING_DIR="$PROJECT_ROOT/electron/build-staging"
rm -rf "$STAGING_DIR"
mkdir -p "$STAGING_DIR"
bash "$PROJECT_ROOT/scripts/fetch-router.sh" "$STAGING_DIR/router"

if [[ ! -f "$STAGING_DIR/router/server.js" ]]; then
    echo "ERROR: Router fetch failed — server.js not found in staged dir"
    exit 1
fi
echo "Router staged."
echo ""

# Step 3b: Bundle a real Node.js binary so 9Router and MCP servers don't
# fall back to ELECTRON_RUN_AS_NODE on user machines without system node.
# Two wins:
#   1. Dock cleanliness — Electron-as-Node fallback is the second probable
#      source of the bouncing "exec" icon next to OpenSwarm on fresh Macs
#      (Python.app wrapping addresses the first). Real node is a clean
#      background process that LaunchServices never registers in the dock.
#   2. Cold-start speed — re-execing the OpenSwarm Electron binary as Node
#      pays the full Electron startup cost (~5-15s on first launch incl.
#      Gatekeeper/XProtect verification), then more for the Next.js server
#      to boot. Real node starts in ~50ms. Shrinks the splash window
#      proportionally and reduces the "frontend up but nothing works"
#      tail (analytics.py:196 awaits 9Router during backend lifespan).
# Pinned to Node 20 LTS (NODE_MODULE_VERSION 115). 9router 0.3.60 has zero
# native bindings (sql.js, not better-sqlite3), so any Node 18+ works
# regardless. The bundled MCP servers (mcp-bundles/) are esbuild outputs
# with target=node22 — Node 20 covers the syntax + builtins they use.
echo "[3b/5] Bundling Node.js runtime..."
NODE_VERSION="v20.18.1"
NODE_STAGE_DIR="$STAGING_DIR/node"
mkdir -p "$NODE_STAGE_DIR"

# Per-arch download helper. Stages each arch under its own subdir so the
# .app can ship both and pick at runtime via process.arch (see
# electron/main.js getBundledNodePath). Slightly larger DMG (~25MB extra
# per arch we ship) but eliminates any beforePack-hook complexity in
# electron-builder's publish-mode dual-arch flow.
download_node_for_arch() {
    local arch="$1"  # arm64 | x64
    local out_dir="$NODE_STAGE_DIR/$arch"
    if [[ -f "$out_dir/bin/node" ]]; then
        echo "[3b] Node $NODE_VERSION ($arch) already cached"
        return 0
    fi
    rm -rf "$out_dir"
    mkdir -p "$out_dir/bin"
    local tarball="node-${NODE_VERSION}-darwin-${arch}.tar.gz"
    local url="https://nodejs.org/dist/${NODE_VERSION}/${tarball}"
    echo "[3b] Downloading $tarball..."
    local tmp; tmp=$(mktemp -d)
    curl -fsSL --progress-bar -o "$tmp/node.tar.gz" "$url"
    tar xzf "$tmp/node.tar.gz" -C "$tmp"
    # Ship just the `node` binary. We don't need npm/npx/corepack at runtime —
    # all router + MCP code is pre-bundled. ~50 MB per arch -> ~25 MB after
    # gzip/dmg compression.
    cp "$tmp/node-${NODE_VERSION}-darwin-${arch}/bin/node" "$out_dir/bin/node"
    chmod +x "$out_dir/bin/node"
    rm -rf "$tmp"
    echo "[3b] Node $NODE_VERSION ($arch) staged ($(du -h "$out_dir/bin/node" | cut -f1))"
}

# Publish mode builds both DMGs from one invocation, so always stage both.
# Single-arch local/sign builds only need the host arch.
if $PUBLISH_MODE; then
    download_node_for_arch arm64
    download_node_for_arch x64
else
    HOST_ARCH=$(uname -m)
    if [[ "$HOST_ARCH" == "arm64" ]]; then
        download_node_for_arch arm64
    elif [[ "$HOST_ARCH" == "x86_64" ]]; then
        download_node_for_arch x64
    else
        echo "WARNING: unknown host arch $HOST_ARCH — skipping node bundle (will fall back to ELECTRON_RUN_AS_NODE)"
    fi
fi
echo ""

# Step 3c: Pre-build the webapp-template node_modules archive so first-app
# create on a fresh user install decompresses (~3 s) instead of running a
# live `npm install` (~22 s). The backend's _try_extract_bundled_archive
# is sha-tagged + falls through cleanly if the archive is missing or
# stale, so this step is purely an optimization — skip silently if the
# template snapshot or npm aren't available.
if [[ -f "$PROJECT_ROOT/backend/apps/outputs/webapp_template/frontend/package.json" ]] \
   && command -v npm >/dev/null 2>&1; then
    echo "[3c/5] Pre-building webapp-template node_modules archive..."
    bash "$PROJECT_ROOT/scripts/build-template-archive.sh"
    echo ""
fi

# Step 4: Snapshot source directories for packaging
# (Router was already staged in step 3; do not touch STAGING_DIR/router/ here.)
echo "[4/5] Snapshotting source directories..."

rsync -a \
    --exclude='__pycache__' --exclude='**/__pycache__' \
    --exclude='*.pyc' --exclude='.venv' \
    --exclude='/data' \
    --exclude='/uv-bin' \
    --exclude='apps/outputs/webapp_template_cache' \
    --exclude='tests' --exclude='**/tests' \
    --exclude='/.env' --exclude='/.env.*' \
    "$PROJECT_ROOT/backend/" "$STAGING_DIR/backend/"
# /data: backend/config/paths.py points DATA_ROOT at ~/Library/Application Support/OpenSwarm/data
# in packaged mode and no code seeds from the bundle, so the entire shipped
# backend/data/ tree was dead weight (and was leaking the dev machine's
# auth.token + install_id + dev session artifacts).
# /uv-bin: source dir holds the universal binary so `bash run.sh` works on either
# host arch; we stage per-arch thin slices below so each DMG ships only its slice.
# webapp_template_cache: a pre-built node_modules.tar.gz that gets shipped
# to speed up first-app-create. Apple notarization extracts it and rejects
# the build because upstream native binaries inside (esbuild, fsevents, etc.)
# aren't signed with our Developer ID. Backend's _try_extract_bundled_archive
# in view_builder_templates.py falls through cleanly when the archive is
# missing, so first-app create just runs `npm install` (about 90s extra).
# Long-term fix: sign native binaries before tarring in build-template-archive.sh.
# Note: .env exclude is anchored to the backend/ source root (`/.env` /
# `/.env.*`), not recursive. The vendored webapp-template snapshot at
# backend/apps/outputs/webapp_template/.env.example MUST be shipped so
# new App workspaces can seed from it; recursive `**/.env*` excludes
# would strip it. The top-level backend/.env is still excluded (it's
# (re)generated at the production .env step below).

# Production .env: just the OAuth helper base URL. Google client_id/secret are no
# longer shipped: nothing in backend/ or frontend/ reads GOOGLE_OAUTH_CLIENT_{ID,
# SECRET} at runtime, so we don't bake a secret into the packaged app.
SHIP_OAUTH_BASE_URL="${OPENSWARM_OAUTH_BASE_URL_OVERRIDE:-https://api.openswarm.com}"
mkdir -p "$STAGING_DIR/backend"
cat > "$STAGING_DIR/backend/.env" <<EOF
# OAuth helper base URL.
OPENSWARM_OAUTH_BASE_URL=${SHIP_OAUTH_BASE_URL}
EOF
echo "Staged production .env"

# Per-arch slice of the universal uv/uvx for shipping. The source-tree uv-bin/
# stays universal so dev (`bash run.sh`) works on either host arch; thinning
# into staging means each per-arch DMG ships only its slice (~48 MB savings
# vs the 97 MB universal binary the build used to put in both DMGs).
echo "Slicing uv per-arch into staging..."
for arch in arm64 x64; do
    lipo_arch=$arch
    [[ "$arch" == "x64" ]] && lipo_arch=x86_64
    mkdir -p "$STAGING_DIR/uv-bin/$arch"
    lipo "$UV_BIN_DIR/uv"  -thin "$lipo_arch" -output "$STAGING_DIR/uv-bin/$arch/uv"
    lipo "$UV_BIN_DIR/uvx" -thin "$lipo_arch" -output "$STAGING_DIR/uv-bin/$arch/uvx"
    chmod +x "$STAGING_DIR/uv-bin/$arch/uv" "$STAGING_DIR/uv-bin/$arch/uvx"
done

rsync -a \
    --exclude='__pycache__' --exclude='**/__pycache__' \
    --exclude='*.pyc' --exclude='.venv' --exclude='**/.venv' \
    --exclude='**/node_modules' \
    "$PROJECT_ROOT/debugger/" "$STAGING_DIR/debugger/"

rsync -a "$PROJECT_ROOT/frontend/dist/" "$STAGING_DIR/frontend/"

echo ""
printf '\033[1;42;97m%s\033[0m\n' "========================================"
printf '\033[1;42;97m%s\033[0m\n' "  ✅ SOURCE SNAPSHOT COMPLETE            "
printf '\033[1;42;97m%s\033[0m\n' "  It is now safe to modify your codebase."
printf '\033[1;42;97m%s\033[0m\n' "========================================"
echo ""

# Provenance stamp: record the exact commit this artifact was built from.
# electron/build-info.json ships inside the asar; main.js reads it for the
# startup [provenance] log line and the About panel. Gitignored + regenerated.
BUILD_SHA=$(git -C "$PROJECT_ROOT" rev-parse HEAD 2>/dev/null || echo unknown)
BUILD_VERSION=$(node -e "console.log(require('$PROJECT_ROOT/electron/package.json').version)")
BUILD_CHANNEL=stable; [[ "$BUILD_VERSION" == *-* ]] && BUILD_CHANNEL=experimental
cat > "$PROJECT_ROOT/electron/build-info.json" <<EOF
{"sha":"$BUILD_SHA","shortSha":"${BUILD_SHA:0:12}","builtAt":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","channel":"$BUILD_CHANNEL","version":"$BUILD_VERSION"}
EOF
echo "Stamped build-info.json: sha=${BUILD_SHA:0:12} channel=$BUILD_CHANNEL"

# Step 5: Package with electron-builder
echo "[5/5] Packaging with electron-builder..."
cd "$PROJECT_ROOT/electron"
# npm ci: lockfile-exact, no drift. See frontend note above.
npm ci

# Node's default ~4 GB heap OOMs while codesign'ing the .app on dual-arch
# publish runs (the .app is ~4.8 GB and electron-builder walks every file
# to hash + sign, holding paths + metadata in memory). Bump the old-space
# ceiling so V8 has headroom; 12 GB covers both arches in one invocation.
# Caller's NODE_OPTIONS is respected if already set.
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=12288}"

if $PUBLISH_MODE; then
    npx electron-builder --mac --arm64 --x64 --publish always
elif $SIGN_MODE; then
    ARCH=$(uname -m)
    if [[ "$ARCH" == "arm64" ]]; then
        npx electron-builder --mac --arm64 --publish never
    elif [[ "$ARCH" == "x86_64" ]]; then
        npx electron-builder --mac --x64 --publish never
    else
        npx electron-builder --mac --publish never
    fi
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
