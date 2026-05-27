#!/bin/bash

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ -f "$ROOT_DIR/.env" ]]; then
    set -a
    source "$ROOT_DIR/.env"
    set +a
fi

# Recursively SIGTERM a pid + all of its descendants. We track FRONTEND_PID
# and BACKEND_PID below, but each of those is a `bash` wrapper that has its
# own grandchildren (vite, uvicorn, npm). A flat `kill $FRONTEND_PID` leaves
# the grandchildren alive holding their ports until the OS reaps them
# minutes later — visible to the user as port-already-in-use the next time
# they hit the App Builder.
kill_tree() {
    local pid=$1 sig=${2:-TERM}
    local children
    children=$(pgrep -P "$pid" 2>/dev/null)
    for child in $children; do
        kill_tree "$child" "$sig"
    done
    kill -"$sig" "$pid" 2>/dev/null
}

# Previously this was `kill 0`, which SIGTERMs the entire process group.
# That's fast but propagates UP into OpenSwarm — when this workspace's
# cleanup fired on ViewEditor unmount or runtime/stop, it tore down the
# OpenSwarm dev stack (Terminated: 15) and left port 8324 stuck. Now we
# only kill our own tracked subtree, which keeps containment without
# requiring an OS-level session wall.
cleanup() {
    echo ""
    echo "Shutting down all processes..."
    [[ -n "${FRONTEND_PID:-}" ]] && kill_tree "$FRONTEND_PID" TERM
    [[ -n "${BACKEND_PID:-}" ]] && kill_tree "$BACKEND_PID" TERM
    wait 2>/dev/null
}
trap cleanup EXIT

if [[ "${BACKEND_PORT}" == "NONE" || -z "${BACKEND_PORT}" || ! -f "$ROOT_DIR/backend/run.sh" ]]; then
    # Frontend-only is the safe default: BACKEND_PORT=NONE (frontend-only app),
    # OR unset/empty (e.g. .env missing — never start a backend that isn't
    # configured), OR there is genuinely no backend/run.sh to run. Without the
    # last two guards an unset BACKEND_PORT fell through to the backend branch
    # and `bash backend/run.sh` died with "No such file or directory", tearing
    # the whole app down before the frontend could show.
    echo "Running frontend only (no backend configured)."
    echo ""

    bash "$ROOT_DIR/frontend/run.sh" 2>&1 | awk '{printf "\033[32m[frontend]\033[0m %s\n", $0; fflush()}' &
    FRONTEND_PID=$!

    while true; do
        if ! kill -0 $FRONTEND_PID 2>/dev/null; then
            echo ""
            echo "ERROR: Frontend process exited. Tearing down..."
            exit 1
        fi
        sleep 2
    done
else
    BACKEND_URL="http://localhost:${BACKEND_PORT:-8324}/api/health/check"
    MAX_WAIT=60

    echo "Starting backend..."
    echo ""

    bash "$ROOT_DIR/backend/run.sh" 2>&1 | awk '{printf "\033[34m[backend]\033[0m  %s\n", $0; fflush()}' &
    BACKEND_PID=$!

    echo "Waiting for backend to be ready..."
    elapsed=0
    while [ $elapsed -lt $MAX_WAIT ]; do
        if ! kill -0 $BACKEND_PID 2>/dev/null; then
            echo "ERROR: Backend process died before becoming ready. Aborting."
            exit 1
        fi
        if curl -s -o /dev/null -w "%{http_code}" "$BACKEND_URL" 2>/dev/null | grep -q "200"; then
            echo ""
            echo "Backend is ready! Starting frontend..."
            echo ""
            break
        fi
        sleep 1
        elapsed=$((elapsed + 1))
    done

    if [ $elapsed -ge $MAX_WAIT ]; then
        echo "ERROR: Backend failed to start within ${MAX_WAIT}s. Aborting."
        exit 1
    fi

    bash "$ROOT_DIR/frontend/run.sh" 2>&1 | awk '{printf "\033[32m[frontend]\033[0m %s\n", $0; fflush()}' &
    FRONTEND_PID=$!

    while true; do
        if ! kill -0 $BACKEND_PID 2>/dev/null; then
            echo ""
            echo "ERROR: Backend process exited. Tearing down..."
            exit 1
        fi
        if ! kill -0 $FRONTEND_PID 2>/dev/null; then
            echo ""
            echo "ERROR: Frontend process exited. Tearing down..."
            exit 1
        fi
        sleep 2
    done
fi
