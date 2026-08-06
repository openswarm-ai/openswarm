#!/bin/bash
# Criteria 1, 4, 5, 6, 7 and 9 in one pass: the known suite at N=12 = 108 site-runs, which is the
# >=100 sample criterion 7 asks for, while the same trials carry the reach, timing and skill data.
#
# Dry run only. The backend must be up with OSW_SENDSCRIPT_DRYRUN=1 (`stack.sh up dry`), so the
# irreversible click is refused in the backend, not by a flag this script sets and does not own.
# Where logs, profiles and run output go. Defaults to runs/ beside this harness; override with
# OSW_BENCH_DIR to keep multi-gigabyte browser profiles off the repo disk.
SP="${OSW_BENCH_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/runs}"
mkdir -p "$SP"
# The harness itself lives beside this script; SP is only for run OUTPUT.
HARNESS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Repo root from this script's own location, so the harness works in any checkout.
TREE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$TREE" || exit 1

N="${N:-12}"
OUT="$SP/c7_r6.txt"
: > "$OUT"
echo "started $(date +%H:%M:%S), N=$N, log=$SP/r6_be.log" >> "$OUT"
OSW_BASE=http://127.0.0.1:8326 OSW_LOG="$SP/r6_be.log" \
  ./backend/.venv/bin/python "$HARNESS/bench.py" known "$N" >> "$OUT" 2>&1
echo "########## DONE $(date +%H:%M:%S)" >> "$OUT"
echo "backend restarts during the sweep: $(grep -c 'BACKEND RESTARTED' "$SP/r6_be.log")" >> "$OUT"
