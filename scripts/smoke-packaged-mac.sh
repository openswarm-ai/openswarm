#!/usr/bin/env bash
# Smoke a SIGNED, NOTARIZED Mac build the way a user receives it.
#
# "Works in dev" has repeatedly not meant "works packaged" here: dictation died in prod because a
# Finder-launched app inherits a PATH with no brew, and the bundled Python and 9Router live at
# different paths than dev. So this runs the real .app out of the real DMG, dequarantined the way
# a download would be, and checks the things that have actually broken before.
#
#   bash scripts/smoke-packaged-mac.sh path/to/OpenSwarm-arm64.dmg
#
# Exits non-zero on the first hard failure. Every check prints PASS or FAIL with what it saw, so a
# red line is a finding and not a puzzle.

set -uo pipefail
DMG="${1:?usage: smoke-packaged-mac.sh <path-to-dmg>}"
MNT="/tmp/osw-smoke-$$"
APP=""
PASS=0
FAIL=0

ok()   { PASS=$((PASS+1)); printf "  PASS  %s%s\n" "$1" "${2:+ ($2)}"; }
bad()  { FAIL=$((FAIL+1)); printf "  FAIL  %s%s\n" "$1" "${2:+ ($2)}"; }
warn() { printf "  WARN  %s%s\n" "$1" "${2:+ ($2)}"; }   # visible, not fatal
step() { printf "\n=== %s ===\n" "$1"; }

cleanup() {
  # Order matters and so does patience: the app holds the volume open, and rm-ing a still-mounted
  # DMG spews hundreds of "Read-only file system" lines that bury the actual results.
  pkill -f "/tmp/osw-smoke-run-$$/OpenSwarm.app" 2>/dev/null
  [ -n "${APP:-}" ] && pkill -f "$MNT/OpenSwarm.app" 2>/dev/null
  sleep 2
  hdiutil detach "$MNT" -force -quiet 2>/dev/null || hdiutil detach "$MNT" -quiet 2>/dev/null
  mount | grep -q "$MNT" || rmdir "$MNT" 2>/dev/null
  rm -rf "/tmp/osw-smoke-run-$$"
}
trap cleanup EXIT

step "0. Nothing else is already pretending to be OpenSwarm"
# An OpenSwarm that is already up owns the single-instance lock, so the copy under test quits the
# instant it launches and step 5 reports "the backend never answered". It answered fine; you were
# just talking to nobody. Refuse to run rather than hand back a scary lie.
STRAY=$(pgrep -f "OpenSwarm.app/Contents/MacOS/OpenSwarm" | tr '\n' ' ')
if [ -n "${STRAY// /}" ]; then
  bad "another OpenSwarm is running" "pids: $STRAY -- kill it, then re-run"
  exit 1
fi
ok "no other OpenSwarm running"

step "1. Mount the DMG the way a download arrives"
mkdir -p "$MNT"
if hdiutil attach "$DMG" -mountpoint "$MNT" -nobrowse -quiet; then
  ok "mounted" "$(basename "$DMG")"
else
  bad "could not mount the DMG"; exit 1
fi
APP="$MNT/OpenSwarm.app"
[ -d "$APP" ] && ok "OpenSwarm.app present" || { bad "no .app inside the DMG"; exit 1; }

step "2. Signing, notarization and DRM"
codesign --verify --deep --strict "$APP" 2>/dev/null && ok "codesign valid" || bad "codesign INVALID"
# -dvv prints the Authority chain; --requirements prints the requirement string, which does NOT
# contain the authority name and made this read as unsigned on a correctly signed build.
AUTH=$(codesign -dvv "$APP" 2>&1 | grep -m1 "^Authority=")
grep -q "Developer ID Application" <<<"$AUTH" \
  && ok "signed with a Developer ID" "${AUTH#Authority=}" || bad "not a Developer ID signature" "$AUTH"
SPCTL=$(spctl -a -vvv -t install "$APP" 2>&1 | tr '\n' ' ')
grep -q "Notarized Developer ID" <<<"$SPCTL" && ok "notarized" || bad "NOT notarized" "$SPCTL"
xcrun stapler validate "$APP" >/dev/null 2>&1 && ok "notarization stapled" || bad "staple missing"
# -t exec is the assessment Gatekeeper runs when LAUNCHING, and it is the only one that catches a
# broken code seal. A copy with one file edited inside the bundle still passes codesign -dvv and
# still staples, then greets the user with "OpenSwarm is damaged and can't be opened". Measured on a
# real bundle 2026-08-13: "a sealed resource is missing or invalid".
EXEC=$(spctl -a -vvv -t exec "$APP" 2>&1 | tr '\n' ' ')
grep -q "accepted" <<<"$EXEC" && grep -q "Notarized Developer ID" <<<"$EXEC" \
  && ok "Gatekeeper accepts it for launch" || bad "Gatekeeper would REFUSE to launch it" "$EXEC"
# The wrapper a user actually downloads. The app inside can be perfect while the DMG carries no
# signature at all, and every check above would still pass. Reported, not fatal: 1.7.7 stable ships
# unsigned too, so failing here would block a release for a pre-existing condition.
DMG_SPCTL=$(spctl -a -vvv -t open --context context:primary-signature "$DMG" 2>&1 | tr '\n' ' ')
if grep -q "accepted" <<<"$DMG_SPCTL"; then
  ok "the DMG itself is signed and accepted"
else
  warn "the DMG wrapper is unsigned (users see this only if they run the app straight off the mounted image)" "$DMG_SPCTL"
fi
# The Widevine signature is what makes Spotify/Netflix play in the embedded browser. Shipped builds
# carried a DEVELOPMENT certificate for a month because sign-pkg was handed the wrong path.
FW="$APP/Contents/Frameworks/Electron Framework.framework"
[ -f "$FW/Resources/Electron Framework.sig" ] \
  && ok "Widevine VMP signature present" || bad "no VMP signature (DRM will be dead)"

step "3. The version and the code actually inside the bundle"
VER=$(defaults read "$APP/Contents/Info.plist" CFBundleShortVersionString 2>/dev/null)
[ -n "$VER" ] && ok "version" "$VER" || bad "no version in Info.plist"
RES="$APP/Contents/Resources"
# The build is only worth smoking if it contains the fixes it claims to.
grep -rq "pending_continuation" "$RES/backend/apps/agents/manager/run/TurnRunner.py" 2>/dev/null \
  && ok "MCP activation hard-stop is in the bundle" \
  || bad "MCP hard-stop MISSING (stale build)"
grep -rq "lend_credential_for_cloud" "$RES/backend/apps/workflows/cloud/handover.py" 2>/dev/null \
  && ok "cloud credential lease wiring is in the bundle" \
  || bad "credential lease wiring MISSING (cloud runs cannot work)"
grep -rq "sign-in has expired" "$RES/backend/apps/tools_lib/mcp_failure_reason.py" 2>/dev/null \
  && ok "readable MCP failures are in the bundle" \
  || bad "MCP failure translation MISSING"

step "4. Bundled runtimes, at their packaged paths"
PY=$(ls -d "$RES/python-env/bin/python3"* 2>/dev/null | head -1)
[ -n "$PY" ] && ok "bundled Python present" "$(basename "$PY")" || bad "no bundled Python"
[ -n "$PY" ] && { "$PY" -c "import fastapi, anthropic" 2>/dev/null \
  && ok "bundled Python imports its deps" || bad "bundled Python cannot import fastapi/anthropic"; }
ls "$RES/router" >/dev/null 2>&1 && ok "9Router bundled" || bad "9Router missing from Resources"
# The dictation regression: whisper shelled out to ffmpeg at boot, and a Finder launch has no brew.
grep -rq -- "--convert" "$RES/backend/apps" 2>/dev/null \
  && bad "whisper --convert is back (dictation dies without brew on PATH)" \
  || ok "no whisper --convert (the prod dictation killer)"

step "5. Launch it with a Finder-like PATH and see the backend come up"
# Copy it off the DMG first, because that is what a user does and because running from the
# read-only volume makes the auto-updater throw and take the whole app down about a second in,
# which reads as "the backend never started" and is nothing of the sort.
RUNDIR="/tmp/osw-smoke-run-$$"
rm -rf "$RUNDIR"; mkdir -p "$RUNDIR"
cp -R "$APP" "$RUNDIR/" && ok "copied to a writable volume" || bad "could not copy the app off the DMG"
RUNAPP="$RUNDIR/OpenSwarm.app"
xattr -dr com.apple.quarantine "$RUNAPP" 2>/dev/null
# Nothing may already own :8324, or the curl below is answered by a stray dev backend and the smoke
# reports the app booted when it never did. Assert the port is free BEFORE launching, so the only
# thing that can answer is the app under test.
if lsof -nP -iTCP:8324 -sTCP:LISTEN >/dev/null 2>&1; then
  bad "port :8324 is already taken" "kill the other backend first, or this check passes on its reply"
fi
# OPENSWARM_NO_UPDATE: this instance shares the REAL updater cache; with the experimental toggle off it downloaded Latest and the pending 1.7.9 landed on the user's app at its next quit (2026-09-03).
OPENSWARM_NO_UPDATE=1 PATH="/usr/bin:/bin:/usr/sbin:/sbin" "$RUNAPP/Contents/MacOS/OpenSwarm" >/tmp/osw-smoke.log 2>&1 &
LAUNCHED=$!
BOOTED=0
for _ in $(seq 1 60); do
  sleep 2
  curl -s -m 3 -o /dev/null "http://127.0.0.1:8324/api/settings" && { BOOTED=1; break; }
  kill -0 "$LAUNCHED" 2>/dev/null || break
done
if [ "$BOOTED" = 1 ]; then
  ok "backend answered on :8324 from a brew-less PATH"
else
  bad "backend never answered" "see /tmp/osw-smoke.log"
fi
kill "$LAUNCHED" 2>/dev/null

printf "\n%s\n" "$(printf '=%.0s' {1..60})"
printf "PACKAGED SMOKE: %d passed, %d failed\n" "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
