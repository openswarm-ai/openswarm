#!/bin/bash
# Install-then-update, against REAL published releases. Lifted in shape from hermes-agent's
# install-e2e workflow, which samples real release tags rather than testing a build against itself.
#
# Why this exists: every teardown we run is on an UNRELEASED version, so there is nothing to
# download, which is exactly why the quit-with-pending-update orphan (ENG-223) hid for months.
# STRESS_TEST.md 5b describes this drill; it was never automated, so it happened about never.
#
# Safe by construction: a throwaway HOME, so the app cannot touch the real profile, the real
# auth token, or the real session store. Nothing here signs, publishes, or writes to the repo.
#
#   bash scripts/drills/install-update-drill.sh            # newest published, and the one before
#   bash scripts/drills/install-update-drill.sh v1.7.7     # from a specific older version
set -uo pipefail

WORK="${OSW_DRILL_DIR:-/tmp/osw-update-drill}"
LOG="$WORK/drill.log"
FAILURES=0

say() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG"; }
fail() { echo "[$(date +%H:%M:%S)] FAIL: $*" | tee -a "$LOG"; FAILURES=$((FAILURES + 1)); }

CACHE="${OSW_DRILL_CACHE:-$HOME/.cache/osw-drill}"
rm -rf "$WORK"; mkdir -p "$WORK" "$CACHE"; : > "$LOG"

# --- pick the versions, from what users can actually install ---
# No mapfile / readarray: macOS ships bash 3.2 and this drill has to run on the machine that cuts
# the release, not only on a Linux runner.
PUBLISHED=$(gh release list --limit 40 --json tagName,isDraft \
  --jq '.[] | select(.isDraft == false) | .tagName' 2>/dev/null)
COUNT=$(printf '%s\n' "$PUBLISHED" | grep -c . )
if [ "$COUNT" -lt 2 ]; then
  echo "need at least two PUBLISHED releases to drill an update; found $COUNT"
  exit 2
fi
NEWEST=$(printf '%s\n' "$PUBLISHED" | sed -n 1p)
FROM="${1:-$(printf '%s\n' "$PUBLISHED" | sed -n 2p)}"
say "update path: $FROM  ->  $NEWEST   (of $COUNT published releases)"

# --- the artifact a real user gets ---
ASSET=$(gh release view "$FROM" --json assets --jq \
  '.assets[].name | select(test("arm64.*\\.dmg$|^OpenSwarm-arm64\\.dmg$"))' 2>/dev/null | head -1)
if [ -z "$ASSET" ]; then fail "$FROM publishes no arm64 dmg; nothing a mac user could install"; exit 1; fi
# Cached by TAG, never by asset name: two releases both ship "OpenSwarm-arm64.dmg", so caching on
# the name alone would silently drill yesterday's build while claiming to drill this one.
CACHED="$CACHE/$FROM-$ASSET"
if [ -s "$CACHED" ]; then
  say "using cached $ASSET for $FROM ($(du -h "$CACHED" | cut -f1))"
else
  say "downloading $ASSET from $FROM"
  gh release download "$FROM" --pattern "$ASSET" --dir "$CACHE" >>"$LOG" 2>&1 \
    || { fail "could not download $ASSET"; exit 1; }
  mv "$CACHE/$ASSET" "$CACHED"
fi
cp "$CACHED" "$WORK/$ASSET"

MNT="$WORK/mnt"
hdiutil attach "$WORK/$ASSET" -nobrowse -quiet -mountpoint "$MNT" >>"$LOG" 2>&1 \
  || { fail "the published dmg would not mount"; exit 1; }
cp -R "$MNT/OpenSwarm.app" "$WORK/OpenSwarm.app" 2>>"$LOG"
hdiutil detach "$MNT" -quiet >>"$LOG" 2>&1
[ -d "$WORK/OpenSwarm.app" ] || { fail "no app inside the dmg"; exit 1; }

INSTALLED=$(defaults read "$WORK/OpenSwarm.app/Contents/Info" CFBundleShortVersionString 2>/dev/null)
say "installed version: $INSTALLED"
[ "v$INSTALLED" = "$FROM" ] || fail "the dmg for $FROM contains $INSTALLED"

# --- launch it on a throwaway HOME so the real profile is untouchable ---
export HOME="$WORK/home"; mkdir -p "$HOME"
say "launching with HOME=$HOME (the real profile is not reachable from here)"
"$WORK/OpenSwarm.app/Contents/MacOS/OpenSwarm" >"$WORK/app.log" 2>&1 &
APP_PID=$!
LAUNCH_AT=$SECONDS
say "app pid $APP_PID"

# --- wait for the updater to find the newer published version ---
DEADLINE=$((SECONDS + 300))
SAW_UPDATE=0
while [ $SECONDS -lt $DEADLINE ]; do
  sleep 5
  kill -0 $APP_PID 2>/dev/null || { fail "the app exited on its own $((SECONDS - LAUNCH_AT))s after launch"; break; }
  if grep -qiE "update-downloaded|Update downloaded|updateDownloaded" "$WORK/app.log" 2>/dev/null; then
    SAW_UPDATE=1; say "updater reported a downloaded update $((SECONDS - LAUNCH_AT))s after launch"; break
  fi
done
[ $SAW_UPDATE -eq 1 ] || fail "no update downloaded in $((SECONDS - LAUNCH_AT))s while $INSTALLED ran against $NEWEST"

# --- quit normally; teardown IS the test ---
say "quitting normally"
kill -TERM $APP_PID 2>/dev/null
for _ in $(seq 1 30); do kill -0 $APP_PID 2>/dev/null || break; sleep 1; done
kill -0 $APP_PID 2>/dev/null && { fail "the app did not exit within 30s of a normal quit"; kill -9 $APP_PID 2>/dev/null; }

sleep 5
# Per-PID under OUR app dir, never a name grep: a name grep would also match the user's real app.
# -fl, not -afl: macOS pgrep has no -a. Matching the drill PATH, never the app name,
# so the user's own running OpenSwarm can never be counted as our orphan.
ORPHANS=$(pgrep -fl "$WORK/OpenSwarm.app" 2>/dev/null | head -10)
if [ -n "$ORPHANS" ]; then
  fail "orphans survived the quit (the ENG-223 leak):"
  echo "$ORPHANS" | tee -a "$LOG"
  pgrep -f "$WORK/OpenSwarm.app" | xargs -r kill -9 2>/dev/null
else
  say "teardown clean: zero processes left under the drill app"
fi

say "----"
if [ $FAILURES -eq 0 ]; then say "PASS: $FROM installed, updated toward $NEWEST, quit clean"; else say "$FAILURES FAILURE(S); see $LOG"; fi
exit $FAILURES
