#!/bin/bash
# Build a signed + notarized arm64-only DMG for testing on a fresh Mac.
# No publish, no Windows, no x64. Just the one DMG you can drag to a USB
# / send to your other Mac and verify the Python.app + bundled-node fix.
#
# Usage:
#   bash scripts/build-mac-arm64-signed.sh
#
# Output:
#   electron/dist/OpenSwarm-arm64.dmg

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$PROJECT_ROOT/backend/.env"

if [[ -f "$ENV_FILE" ]]; then
    set -a
    source "$ENV_FILE"
    set +a
fi

# Pre-flight checks. Fail fast with a clear message before kicking off
# the 15-30 minute build + notarization round-trip.
missing=()
[[ -z "${APPLE_ID:-}" ]] && missing+=("APPLE_ID")
[[ -z "${APPLE_APP_SPECIFIC_PASSWORD:-}" ]] && missing+=("APPLE_APP_SPECIFIC_PASSWORD")
[[ -z "${APPLE_TEAM_ID:-}" ]] && missing+=("APPLE_TEAM_ID")
if [[ ${#missing[@]} -gt 0 ]]; then
    echo "ERROR: Missing required env vars in $ENV_FILE:" >&2
    printf '  - %s\n' "${missing[@]}" >&2
    exit 1
fi

# Verify the Developer ID cert is in the keychain. Without it, codesign
# silently falls back to ad-hoc and notarization will reject the bundle.
if ! security find-identity -v -p codesigning 2>/dev/null | grep -q "Developer ID Application"; then
    echo "ERROR: No 'Developer ID Application' code-signing identity found in keychain." >&2
    echo "  Install it from your Apple Developer account before running this script." >&2
    exit 1
fi

# Force arm64-only by overriding the dual-arch publish path inside
# build-app.sh. We pass --sign which triggers SIGN_MODE (sign + notarize,
# no publish) and on arm64 hosts already builds arm64-only via the
# `if [[ "$ARCH" == "arm64" ]]` branch in the existing script.
HOST_ARCH=$(uname -m)
if [[ "$HOST_ARCH" != "arm64" ]]; then
    echo "WARNING: Host arch is $HOST_ARCH, not arm64. The DMG will still be" >&2
    echo "  built for arm64 because we're invoking electron-builder with" >&2
    echo "  --mac --arm64 explicitly, but the bundled python-env / node will" >&2
    echo "  be x64, wrong arch for an M4 Mac. Run this on an arm64 host." >&2
    exit 1
fi

echo "============================================================"
echo "  OpenSwarm arm64 signed+notarized DMG (test build)"
echo "  apple_id:   $APPLE_ID"
echo "  team_id:    $APPLE_TEAM_ID"
echo "  output:     $PROJECT_ROOT/electron/dist/OpenSwarm-arm64.dmg"
echo "============================================================"
echo ""

# Run the existing master build script in --sign mode. On an arm64 host
# this produces arm64-only artifacts (DMG + zip + blockmap + latest-mac.yml).
# Notarization happens automatically via electron/scripts/notarize.js when
# APPLE_ID + APPLE_TEAM_ID are set.
bash "$SCRIPT_DIR/build-app.sh" --sign

DMG_PATH="$PROJECT_ROOT/electron/dist/OpenSwarm-arm64.dmg"

echo ""
echo "============================================================"
if [[ -f "$DMG_PATH" ]]; then
    echo "  Build complete."
    echo ""
    ls -lh "$DMG_PATH"
    echo ""
    echo "  Verification:"
    echo "    spctl -a -vvv -t open --context context:primary-signature \"$DMG_PATH\""
    echo "    xcrun stapler validate \"$DMG_PATH\""
    echo ""
    echo "  Transfer to your other Mac (AirDrop, USB, scp, etc.) and"
    echo "  double-click. The first launch will be Gatekeeper-checked"
    echo "  but should open without the right-click 'Open' workaround."
else
    echo "  ERROR: Expected DMG not found at $DMG_PATH"
    echo "  Check the build log above for the actual output path."
    exit 1
fi
echo "============================================================"
