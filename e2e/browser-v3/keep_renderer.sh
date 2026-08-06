#!/bin/bash
# Keep an Electron renderer alive for the length of a sweep.
#
# A 45-run sweep takes over an hour and the app does not reliably survive it: one run quit partway
# through and 24 of 45 rows came back "dispatch refused: no dashboard", which scored as a 29% reach
# that measured nothing but my own dead window. Relaunching by hand between runs is not a fix, it
# just moves the gap to whenever I am not looking.
#
# Restarts on exit, and waits for webpack first: Electron launched against a dead :3026 loads a
# blank page and quits immediately, which is how the window went missing the first time.
# Where logs, profiles and run output go. Defaults to runs/ beside this harness; override with
# OSW_BENCH_DIR to keep multi-gigabyte browser profiles off the repo disk.
SP="${OSW_BENCH_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/runs}"
mkdir -p "$SP"
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/electron" || exit 1

while true; do
  until curl -s -o /dev/null --max-time 4 "http://localhost:${OPENSWARM_DEV_PORT:-3026}"; do sleep 5; done
  ELECTRON_DEV=1 OPENSWARM_DEV_PORT="${OPENSWARM_DEV_PORT:-3026}" OPENSWARM_PORT="${OPENSWARM_PORT:-8326}" \
    ./node_modules/.bin/electron . --user-data-dir="$SP/udd" >> "$SP/renderer.log" 2>&1
  echo "[keep_renderer] electron exited at $(date +%H:%M:%S), restarting" >> "$SP/renderer.log"
  sleep 5
done
