#!/bin/bash
# Criterion 2: verified writes, on the three accounts authorised for real sends.
#
# Needs a LIVE backend (`stack.sh up live`). Every round posts a unique marker, audits the
# destination by reading it, deletes, and audits again. Markers print on every row so anything
# stranded can be cleaned up by hand.
# Where logs, profiles and run output go. Defaults to runs/ beside this harness; override with
# OSW_BENCH_DIR to keep multi-gigabyte browser profiles off the repo disk.
SP="${OSW_BENCH_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/runs}"
mkdir -p "$SP"
# Repo root from this script's own location, so the harness works in any checkout.
TREE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$TREE" || exit 1
OUT="$SP/c2_r7.txt"

# The operator names the accounts, this file never does. These rounds POST to real profiles, so the
# handles have to be a deliberate act by whoever runs it, not a default baked into an open-source
# repo. Refuse rather than run: a missing handle would post and then audit a malformed URL, and the
# round would report "unprovable" as though the product were at fault.
for v in OSW_CANARY_X_HANDLE OSW_CANARY_REDDIT_HANDLE; do
  if [ -z "${!v}" ]; then
    echo "refusing: \$$v is not set. These rounds write to real accounts; name them explicitly."
    exit 2
  fi
done

: > "$OUT"
for i in $(seq 1 "${ROUNDS:-7}"); do
  echo "########## ROUND $i $(date +%H:%M:%S)" >> "$OUT"
  OSW_CANARY_BASE=http://127.0.0.1:8326 OSW_CANARY_LOG="$SP/r7_be.log" \
    timeout 2400 ./backend/.venv/bin/python scripts/browser_canary.py --live --sites x,linkedin,reddit \
    >> "$OUT" 2>&1
  echo "  (backend restarts so far: $(grep -c 'BACKEND RESTARTED' "$SP/r7_be.log" 2>/dev/null))" >> "$OUT"
done
echo "########## DONE $(date +%H:%M:%S)" >> "$OUT"
