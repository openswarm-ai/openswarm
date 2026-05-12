#!/bin/bash

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ -f "$ROOT_DIR/.env" ]]; then
    set -a
    source "$ROOT_DIR/.env"
    set +a
fi

cleanup() {
    echo ""
    echo "Shutting down all processes..."
    kill 0 2>/dev/null
    wait 2>/dev/null
}
trap cleanup EXIT

if [[ "${BACKEND_PORT}" == "NONE" ]]; then
    echo "BACKEND_PORT=NONE — running frontend only (no backend)."
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
