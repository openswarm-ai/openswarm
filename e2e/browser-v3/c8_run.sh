#!/bin/bash
# Criterion 8: the frozen holdout, re-measured after the round's changes. Dry run, same stack.
# Where logs, profiles and run output go. Defaults to runs/ beside this harness; override with
# OSW_BENCH_DIR to keep multi-gigabyte browser profiles off the repo disk.
SP="${OSW_BENCH_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/runs}"
mkdir -p "$SP"
# The harness itself lives beside this script; SP is only for run OUTPUT.
HARNESS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Repo root from this script's own location, so the harness works in any checkout.
TREE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$TREE" || exit 1
N="${N:-2}"
OUT="$SP/c8_r6.txt"
: > "$OUT"
echo "started $(date +%H:%M:%S), N=$N" >> "$OUT"
OSW_BASE=http://127.0.0.1:8326 OSW_LOG="$SP/r6_be.log" \
  ./backend/.venv/bin/python "$HARNESS/bench.py" holdout "$N" >> "$OUT" 2>&1
echo "########## DONE $(date +%H:%M:%S)" >> "$OUT"
