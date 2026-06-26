#!/bin/bash
# watch-moves.sh: human-readable, moves-only view of the App Agent.
# Shows just the actions it takes (clicks, keypresses, waits), one per line,
# plus task-start and bridge-missing milestones. Hides all the dispatch/result/
# electron echo noise. Usage: bash backend/watch-moves.sh [logfile]
LOG="${1:-/tmp/openswarm.log}"
tail -f "$LOG" | awk '
  { gsub(/\033\[[0-9;]*m/, "") }                                  # strip color codes
  match($0, /[0-9][0-9]:[0-9][0-9]:[0-9][0-9]/) { t = substr($0, RSTART, 8) }
  /\[app-agent\] START loop/ { print ""; print "=== " t "  TASK START ==="; next }
  /BRIDGE MISSING/           { print t "  !! bridge missing: app is NOT agent-operable, driving UI blind"; next }
  /\[browser-action\]/ {
    sub(/.*\[browser-action\] [A-Za-z]+: /, "")                   # drop everything up to the action
    sub(/ *-> .*/, "")                                            # drop the trailing browser_id
    print t "  > " $0
    next
  }
'
