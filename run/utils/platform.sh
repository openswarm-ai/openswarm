#!/bin/bash
# Cross-platform helpers for the dev shell scripts.
# Sourced by: run/local.sh, backend/run.sh, frontend/run.sh, linter/print_errors.sh
#
# Exports:
#   IS_WINDOWS / IS_MAC / IS_LINUX      ("true" or empty)
#   EXE_EXT                             (".exe" on Windows, "" elsewhere)
#   PY                                  Working Python 3 interpreter command
#   ensure_lf <file>                    Strip CRLF from a file (BSD/GNU sed safe)
#   py_path <unix_path>                 Convert /c/... to C:/... on Windows
#   track_winpid <msys_pid>             Snapshot Win32 pid for later taskkill
#   kill_tree <msys_pid> [SIG]          Kill a process tree (taskkill on Win)

case "$OSTYPE" in
    msys*|cygwin*|mingw*) IS_WINDOWS=true;  EXE_EXT=".exe" ;;
    darwin*)              IS_MAC=true;      EXE_EXT="" ;;
    *)                    IS_LINUX=true;    EXE_EXT="" ;;
esac

# Verify a candidate command actually runs Python 3. Rejects the Microsoft
# Store python.exe / python3.exe stubs, which exit 0 on --version but print
# nothing (and would silently open the Store on real invocation).
_is_real_python3() {
    local out
    out=$("$@" --version 2>&1) || return 1
    [[ "$out" == Python\ 3.* ]]
}

PY=""
if [[ "$IS_WINDOWS" == "true" ]]; then
    _PY_CANDIDATES=("python" "py -3" "python3")
else
    _PY_CANDIDATES=("python3" "python")
fi
for _c in "${_PY_CANDIDATES[@]}"; do
    if _is_real_python3 $_c; then
        PY="$_c"
        break
    fi
done
unset _c _PY_CANDIDATES
if [[ -z "$PY" ]]; then
    echo "ERROR: no working Python 3 interpreter found in PATH" >&2
    echo "       Install Python 3 from https://www.python.org/downloads/" >&2
    exit 1
fi

ensure_lf() {
    local f=$1
    if [[ "$IS_MAC" == "true" ]]; then
        sed -i '' 's/\r//g' "$f"
    else
        sed -i 's/\r//g' "$f"
    fi
}

py_path() {
    if [[ "$IS_WINDOWS" == "true" ]]; then
        cygpath -m "$1"
    else
        printf '%s' "$1"
    fi
}

# On Windows, taskkill needs the Win32 pid. /proc/<msys_pid>/winpid disappears
# once the bash wrapper exits, so we snapshot it right after backgrounding.
# Guarded because `declare -gA` requires bash >= 4.2; macOS system bash is 3.2.
if [[ "$IS_WINDOWS" == "true" ]]; then
    declare -gA WINPIDS=()
fi
track_winpid() {
    [[ "$IS_WINDOWS" == "true" ]] || return 0
    local pid=$1 wp
    wp=$(cat "/proc/$pid/winpid" 2>/dev/null) && WINPIDS[$pid]=$wp
}

kill_tree() {
    local pid=$1 sig=${2:-TERM}
    if [[ "$IS_WINDOWS" == "true" ]]; then
        local wp=${WINPIDS[$pid]:-}
        [[ -z "$wp" ]] && wp=$(cat "/proc/$pid/winpid" 2>/dev/null)
        [[ -z "$wp" ]] && return 0
        if [[ "$sig" == "KILL" ]]; then
            taskkill //F //T //PID "$wp" >/dev/null 2>&1
        else
            taskkill //T //PID "$wp" >/dev/null 2>&1
        fi
    else
        local children
        children=$(pgrep -P "$pid" 2>/dev/null)
        for child in $children; do
            kill_tree "$child" "$sig"
        done
        kill -"$sig" "$pid" 2>/dev/null
    fi
}
