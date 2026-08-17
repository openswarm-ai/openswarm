#!/bin/bash
# Compile the macOS mouse-clamp native addon for one arch and stage it where
# electron-builder's extraResources picks it up (build-staging/haptics/<arch>).
# See electron/native/haptics/haptics.mm for what it fixes.
set -euo pipefail

ARCH="${1:?usage: build-haptics.sh <arm64|x64>}"

HERE="$(cd "$(dirname "$0")/.." && pwd)"   # electron/
# Derive the node-gyp header target from the actually-installed electron so a version bump (e.g. 42.0.0 -> 42.3.3) is auto-tracked instead of silently building against stale headers. Strip any +wvcus suffix; node-gyp wants a plain semver.
ELECTRON_TARGET="$(node -p "require('$HERE/node_modules/electron/package.json').version.split('+')[0]" 2>/dev/null || echo '42.3.3')"
SRC="$HERE/native/haptics"
OUT="$HERE/build-staging/haptics/$ARCH"
# An array, not a string: the local binary path can contain spaces (a checkout under "Projects Claude/"
# split it into two words), while the npx fallback is legitimately several words.
NODE_GYP=("$HERE/node_modules/.bin/node-gyp")
[[ -x "${NODE_GYP[0]}" ]] || NODE_GYP=(npx --yes node-gyp)  # transitive dep usually, npx if not

echo "[haptics] building for arch=$ARCH (electron $ELECTRON_TARGET)"
cd "$SRC"
rm -rf build
"${NODE_GYP[@]}" rebuild \
  --target="$ELECTRON_TARGET" \
  --arch="$ARCH" \
  --dist-url=https://electronjs.org/headers

mkdir -p "$OUT"
cp "build/Release/haptics.node" "$OUT/haptics.node"
echo "[haptics] staged -> $OUT/haptics.node"
file "$OUT/haptics.node"
