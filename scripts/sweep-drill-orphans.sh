#!/bin/bash
# Before any timing pass (and after any drill): kill app dev servers that a throwaway OpenSwarm data
# root left behind, then say whether the machine is quiet enough to measure on.
#
# A packaged drill instance that exits (or is killed by a kill matrix) reparents its apps' vite,
# uvicorn and next-server processes to launchd, and nothing ever boots that data root again to reap
# them: one sat at 500% CPU for 8 hours and voided a whole A/B pass (2026-09-02). This runs the
# backend's own ghost reaper once per drill root, so ownership is decided the way the product decides
# it (a workspace process descended from a LIVE backend is never touched), and every kill is by pid.
#
# usage: scripts/sweep-drill-orphans.sh [extra data roots...]    exit 1 = machine still busy
set -u
cd "$(dirname "$0")/.."
PY=${OSW_PY:-backend/.venv/bin/python}
roots=(/private/tmp/osw-*/data /private/tmp/perf-drill/data "$@")
reaped=0
for root in "${roots[@]}"; do
  [ -d "$root/outputs_workspace" ] || continue
  n=$(OPENSWARM_DATA_ROOT="$root" OSW_NEVER_KILL_ROUTER=1 "$PY" -c 'from backend.apps.outputs.reap_ghost_runtimes import reap_ghost_runtimes; print(reap_ghost_runtimes())' 2>/dev/null || echo 0)
  [ "${n:-0}" != "0" ] && echo "reaped $n ghost app-runtime process(es) under $root"
  reaped=$((reaped + ${n:-0}))
done
sleep 2
cores=$(sysctl -n hw.ncpu)
load=$(sysctl -n vm.loadavg | awk '{print $2}')
idle=$(top -l 2 -n 0 -s 1 | grep "CPU usage" | tail -n 1 | sed -E 's/.* ([0-9.]+)% idle.*/\1/')
echo "sweep: $reaped reaped | load ${load} on ${cores} cores | idle ${idle}%"
echo "top:"; ps -Ao pcpu,pid,comm | sort -rn | head -n 5 | awk '{printf "  %5s%% %s %s\n",$1,$2,$3}' | sed 's#/Applications/OpenSwarm.app/Contents/MacOS/##; s#.*/Frameworks/##'
awk -v i="$idle" 'BEGIN{exit (i+0 < 30) ? 1 : 0}' || { echo "machine is NOT quiet (idle ${idle}% < 30%): find the owner by cwd (lsof -p PID -a -d cwd), kill by pid, then re-run"; exit 1; }
