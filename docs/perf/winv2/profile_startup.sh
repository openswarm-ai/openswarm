#!/bin/bash
# Re-extract real packaged-app startup timings from the installed app's backend
# log. Prints one row per launch: timestamp, version, app-launch ms,
# first-paint ms, backend-http-ready ms. Pipe to a CSV for the metrics table.
#
# Usage: bash profile_startup.sh [path-to-backend.log]
# Default log: AppData/Roaming/openswarm/data/backend.log

LOG="${1:-$HOME/AppData/Roaming/openswarm/data/backend.log}"
if [[ ! -f "$LOG" ]]; then
  echo "no backend.log at $LOG" >&2
  exit 1
fi

echo "launch_ts,version,app_launch_ms,first_paint_ms,backend_http_ready_ms,class"
awk '
  /===== launch/ {
    if (ts != "") emit()
    ts=$3; ver=""
    for (i=1;i<=NF;i++) if ($i ~ /^\(app$/) { ver=$(i+1); gsub(/,/,"",ver) }
    al=""; fp=""; br=""
  }
  /\[perf\] app-launch t=/      { sub(/.*t=/,""); al=$0 }
  /\[perf\] first-paint t=/     { sub(/.*t=/,""); fp=$0 }
  /\[perf\] backend-http-ready t=/ { sub(/.*t=/,""); br=$0 }
  END { if (ts != "") emit() }
  function emit() {
    cls = (br+0 > 20000) ? "cold" : "warm"
    printf "%s,%s,%s,%s,%s,%s\n", ts, ver, al, fp, br, cls
  }
' "$LOG"
