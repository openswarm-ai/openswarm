#!/bin/bash
# The isolated v3 measurement stack: backend :8326, webpack :3026, Electron on its own profile.
#
# One script because rebuilding it by hand three times cost three different half-booted stacks, and a
# half-booted stack does not fail loudly, it just measures nothing and blames the product.
#
#   ./stack.sh up dry    backend refuses the irreversible click (coverage sweeps)
#   ./stack.sh up live    backend really clicks send (canary write tests)
#   ./stack.sh down       everything, SIGTERM then SIGKILL, ports verified free
#   ./stack.sh status     what is up right now
#
# Never touches :8324 / :3000. Those belong to whatever else is on this box.

# Where logs, profiles and run output go. Defaults to runs/ beside this harness; override with
# OSW_BENCH_DIR to keep multi-gigabyte browser profiles off the repo disk.
SP="${OSW_BENCH_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/runs}"
mkdir -p "$SP"
# The harness itself lives beside this script; SP is only for run OUTPUT.
HARNESS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TREE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TAG="${TAG:-run}"

status() {
  # Two bugs lived in the first version of these four lines, and both printed a reassuring 0 over a
  # fully live stack. macOS pgrep has no -c flag at all, so `pgrep -fc` exits on a usage error and
  # the count renders empty; and the patterns were the words I type rather than the words ps prints
  # (uvicorn runs as `python -m uvicorn`). A status check that reads clean while the box is busy is
  # the worst instrument in this directory, because its whole job is to stop a second stack landing
  # on the first. Count with grep on real ps output.
  echo "=== procs ==="
  local ps_out
  ps_out="$(ps -Ao pid,command)"
  for p in "\-m uvicorn backend.main" "bin/webpack" "MacOS/Electron" \
           "keep_renderer" "bench\.py" "browser_canary"; do
    printf "  %-34s %s\n" "$p" "$(echo "$ps_out" | grep -cE "$p")"
  done
  echo "=== ports ==="
  for pt in 8324 8326 3000 3026 20128; do
    printf "  %-6s %s\n" "$pt" "$(lsof -ti tcp:$pt 2>/dev/null | tr '\n' ' ')"
  done
  # Anything on :8324 is the OTHER checkout. Say so out loud: while it is up, the single 9router on
  # :20128 is contended and every timing this stack produces is noise (a sweep once scored 1/9 vs
  # 4/9 with zero code change, purely on that contention).
  if [ -n "$(lsof -ti tcp:8324 2>/dev/null)" ]; then
    echo "  !! another OpenSwarm is on :8324. Do NOT measure, and do NOT kill it."
  fi
}

down() {
  # SCOPED TO THIS STACK ONLY. The first version matched on `uvicorn backend.main`, which is exactly
  # what the OTHER OpenSwarm checkout on this box runs too: one careless `stack.sh down` would have
  # killed a colleague's backend on :8324 mid-session. Nothing here may match a process this script
  # did not start, so identify them by MY ports and MY profile directory, never by a generic name.
  pkill -f "keep_renderer" 2>/dev/null
  pkill -f "BACKEND RESTARTED" 2>/dev/null
  pkill -f "user-data-dir=$SP/udd" 2>/dev/null
  pkill -f "browser_canary" 2>/dev/null
  pkill -f "$HARNESS/bench.py" 2>/dev/null
  sleep 3
  for pt in 8326 3026; do
    pids=$(lsof -ti tcp:$pt 2>/dev/null)
    [ -n "$pids" ] && kill -9 $pids 2>/dev/null
  done
  pkill -9 -f "user-data-dir=$SP/udd" 2>/dev/null
  sleep 1
  status
}

up() {
  local mode="${1:-dry}"
  local dry=0
  [ "$mode" = "dry" ] && dry=1

  # A stale stack under a fresh one is the single most expensive failure here: two backends fight
  # over the one 9router and every number becomes a coin flip. Always start from nothing.
  down >/dev/null 2>&1

  # Supervised, because the backend has died mid-measurement on a clean SIGTERM with no error in
  # its log (2026-08-05 07:44, 52 minutes in, no other stack on the box). An unsupervised death does
  # not announce itself: the harness just starts recording connection errors as product failures.
  # The restart marker goes into the same log the harness slices, so any trial that spans a restart
  # can be excluded instead of counted.
  cd "$TREE" || exit 1
  nohup bash -c '
    while true; do
      OPENSWARM_PORT=8326 OSW_SENDSCRIPT_DRYRUN='"$dry"' OPENSWARM_DEV=1 \
        ./backend/.venv/bin/python -m uvicorn backend.main:app --port 8326 --host 127.0.0.1 \
        >> "'"$SP/${TAG}_be.log"'" 2>&1
      echo "[stack] BACKEND RESTARTED at $(date +%H:%M:%S)" >> "'"$SP/${TAG}_be.log"'"
      sleep 4
    done' > /dev/null 2>&1 &
  disown

  cd "$TREE/frontend" || exit 1
  OPENSWARM_DEV_PORT=3026 OPENSWARM_PORT=8326 \
    ./node_modules/.bin/webpack serve --mode development \
    > "$SP/${TAG}_wp.log" 2>&1 &

  # A real authenticated 200, not just "something accepted a TCP connection". /api/health does not
  # exist (it 404s), and curl calls a 404 a success, so the old check passed the instant the socket
  # opened and handed the next step a backend that had not finished booting.
  echo "waiting for backend :8326 ..."
  for i in $(seq 1 90); do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 \
      -H "Authorization: Bearer $(cat "$TREE/backend/data/auth.token" 2>/dev/null)" \
      "http://127.0.0.1:8326/api/dashboards/list")
    [ "$code" = "200" ] && break
    sleep 2
  done
  echo "waiting for webpack :3026 ..."
  for i in $(seq 1 120); do
    curl -s -o /dev/null --max-time 3 "http://localhost:3026" && break
    sleep 2
  done

  OPENSWARM_DEV_PORT=3026 OPENSWARM_PORT=8326 nohup "$HARNESS/keep_renderer.sh" \
    >> "$SP/renderer.log" 2>&1 &
  disown
  sleep 25
  echo "mode=$mode (OSW_SENDSCRIPT_DRYRUN=$dry) tag=$TAG"
  status
}

case "$1" in
  up) up "$2" ;;
  down) down ;;
  status) status ;;
  *) echo "usage: stack.sh {up dry|up live|down|status}"; exit 1 ;;
esac
