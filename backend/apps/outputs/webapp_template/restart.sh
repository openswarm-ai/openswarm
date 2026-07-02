#!/usr/bin/env bash
# Restart this app's runtime (backend + vite), managed by the OpenSwarm harness.
#
# The runtime is spawned and owned by OpenSwarm, so you can't just kill/rerun
# run.sh from here. This script writes a sentinel the harness watches; the
# harness consumes it and restarts the whole runtime. No API token needed.
# Use after `bash backend_init.sh`, after editing `.env`, or whenever the
# backend must reload code/schema (uvicorn runs WITHOUT --reload on purpose).

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$HERE/.openswarm"
SENTINEL="$HERE/.openswarm/restart-requested"
touch "$SENTINEL"
echo "Restart requested; waiting for the OpenSwarm harness to pick it up..."

for _ in $(seq 1 30); do
    if [[ ! -f "$SENTINEL" ]]; then
        echo "Restart under way. The runtime takes a few seconds to come back;"
        echo "then check .openswarm/terminal.log for boot output:"
        sleep 6
        tail -n 20 "$HERE/.openswarm/terminal.log" 2>/dev/null || true
        exit 0
    fi
    sleep 1
done

rm -f "$SENTINEL"
echo "ERROR: the harness didn't pick up the restart within 30s." >&2
echo "The runtime only runs while the app is open in OpenSwarm (preview card or" >&2
echo "App Builder). If you're running this app standalone via 'bash run.sh'," >&2
echo "just Ctrl-C that process and rerun it instead." >&2
exit 1
