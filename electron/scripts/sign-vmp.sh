#!/bin/bash
# Signs the CastLabs Electron binary with a production VMP certificate via EVS,
# then repairs macOS framework symlinks that npm/signing may strip.
#
# First-time setup (one-time):
#   pip3 install --user castlabs-evs
#   python3 -m castlabs_evs.account signup
#
# After signup, this script runs automatically.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ELECTRON_DIR="$SCRIPT_DIR/../node_modules/electron/dist"
FW_BASE="$ELECTRON_DIR/Electron.app/Contents/Frameworks"

fix_framework_symlinks() {
  [ -d "$FW_BASE" ] || return 0
  for fw in "$FW_BASE"/*.framework; do
    [ -d "$fw/Versions/A" ] || continue
    local name
    name=$(basename "$fw" .framework)
    cd "$fw"
    (cd Versions && ln -sf A Current 2>/dev/null)
    ln -sf "Versions/Current/$name" "$name" 2>/dev/null
    [ -d "Versions/A/Resources" ] && ln -sf Versions/Current/Resources Resources 2>/dev/null
    [ -d "Versions/A/Libraries" ] && ln -sf Versions/Current/Libraries Libraries 2>/dev/null
    [ -d "Versions/A/Helpers" ]   && ln -sf Versions/Current/Helpers Helpers 2>/dev/null
  done
}

if [ ! -d "$ELECTRON_DIR" ]; then
  echo "[vmp] Electron dist not found at $ELECTRON_DIR — skipping VMP signing"
  fix_framework_symlinks
  exit 0
fi

# Always fix symlinks first (npm git installs strip them)
fix_framework_symlinks

if ! python3 -c "import castlabs_evs" 2>/dev/null; then
  echo "[vmp] castlabs-evs not installed. Install with: pip3 install --user castlabs-evs"
  echo "[vmp] Skipping VMP signing — DRM playback will be limited"
  exit 0
fi

VERIFY_OUTPUT=$(python3 -m castlabs_evs.vmp verify-pkg "$ELECTRON_DIR" 2>&1)
if echo "$VERIFY_OUTPUT" | grep -q "Signature is valid" && ! echo "$VERIFY_OUTPUT" | grep -q "development only"; then
  echo "[vmp] Electron already has a valid production VMP signature"
  exit 0
fi

echo "[vmp] Signing Electron with production VMP certificate..."
if python3 -m castlabs_evs.vmp sign-pkg "$ELECTRON_DIR" 2>&1; then
  echo "[vmp] VMP signing successful — full DRM playback enabled"
  # Re-fix symlinks in case signing modified the bundle
  fix_framework_symlinks
else
  echo "[vmp] VMP signing failed — you may need to run: python3 -m castlabs_evs.account signup"
  echo "[vmp] DRM playback will be limited to previews until signed"
fi

exit 0
