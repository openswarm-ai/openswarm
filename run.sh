#!/bin/bash
# The comment above is shebang, DO NOT REMOVE
SCRIPT_ABSPATH="$(readlink -f "${BASH_SOURCE[0]}")"
if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' 's/\r//g' "$SCRIPT_ABSPATH"
else
    sed -i 's/\r//g' "$SCRIPT_ABSPATH"
fi
chmod +x "$SCRIPT_ABSPATH"

PROJECT_ROOT="$(dirname "$SCRIPT_ABSPATH")"

BLUE='\033[0;34m'
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
BOLD='\033[1m'
RESET='\033[0m'

BACKEND_PID=""
FRONTEND_PID=""
ELECTRON_PID=""
SHUTTING_DOWN=false

# Dev ports. Override BOTH to run a second worktree in parallel without colliding on 3000/8324
# (e.g. OPENSWARM_PORT=8425 OPENSWARM_DEV_PORT=3005 bash run.sh). Electron, backend/run.sh, and
# webpack all read these same names, so one export each wires the whole stack.
BACKEND_PORT="${OPENSWARM_PORT:-8324}"
FRONTEND_PORT="${OPENSWARM_DEV_PORT:-3000}"
export OPENSWARM_PORT="$BACKEND_PORT"
export OPENSWARM_DEV_PORT="$FRONTEND_PORT"

kill_tree() {
    local pid=$1 sig=${2:-TERM}
    local children
    children=$(pgrep -P "$pid" 2>/dev/null)
    for child in $children; do
        kill_tree "$child" "$sig"
    done
    kill -"$sig" "$pid" 2>/dev/null
}

cleanup() {
    $SHUTTING_DOWN && return
    SHUTTING_DOWN=true

    echo ""
    echo -e "${YELLOW}${BOLD}Gracefully shutting down all services...${RESET}"

    for pid in $ELECTRON_PID $BACKEND_PID $FRONTEND_PID; do
        [[ -n "$pid" ]] && kill_tree "$pid" TERM
    done

    local elapsed=0
    while (( elapsed < 5 )); do
        local alive=false
        for pid in $ELECTRON_PID $BACKEND_PID $FRONTEND_PID; do
            [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null && alive=true
        done
        $alive || break
        sleep 1
        ((elapsed++))
    done

    for pid in $ELECTRON_PID $BACKEND_PID $FRONTEND_PID; do
        [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null && kill_tree "$pid" KILL
    done

    wait 2>/dev/null
    echo -e "${GREEN}${BOLD}All services stopped.${RESET}"
}

trap 'cleanup; exit 0' INT TERM
trap cleanup EXIT

# --- Ensure bundled uv/uvx for MCP servers ---
UV_BIN_DIR="$PROJECT_ROOT/backend/uv-bin"
if [ ! -f "$UV_BIN_DIR/uvx" ]; then
    echo -e "${YELLOW}${BOLD}[uv]${RESET}       Downloading uv/uvx..."
    mkdir -p "$UV_BIN_DIR"
    ARCH=$(uname -m)
    if [[ "$ARCH" == "arm64" ]]; then
        curl -sL "https://github.com/astral-sh/uv/releases/latest/download/uv-aarch64-apple-darwin.tar.gz" | tar xz -C /tmp
        cp /tmp/uv-aarch64-apple-darwin/uv "$UV_BIN_DIR/uv"
        cp /tmp/uv-aarch64-apple-darwin/uvx "$UV_BIN_DIR/uvx"
    else
        curl -sL "https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-apple-darwin.tar.gz" | tar xz -C /tmp
        cp /tmp/uv-x86_64-apple-darwin/uv "$UV_BIN_DIR/uv"
        cp /tmp/uv-x86_64-apple-darwin/uvx "$UV_BIN_DIR/uvx"
    fi
    chmod +x "$UV_BIN_DIR/uv" "$UV_BIN_DIR/uvx"
    rm -rf /tmp/uv-*-apple-darwin
fi

# --- Reap any backend leftover from a prior unclean exit ---
# If the user double-Ctrl+C'd a previous run, or a workspace's signal
# propagation killed the parent before cleanup() ran SIGKILL, uvicorn
# can still be bound to :8324 even though the shell prompt returned.
# That makes the next `bash run.sh` fail with Errno 48 "Address already
# in use" and leaves the user thinking the dev loop is broken. Free the
# port up front instead of asking the user to debug.
if lsof -ti :$BACKEND_PORT >/dev/null 2>&1; then
    echo -e "${YELLOW}${BOLD}[preflight]${RESET} Port ${BACKEND_PORT} still bound from a prior run, killing stale process..."
    lsof -ti :$BACKEND_PORT | xargs kill -9 2>/dev/null || true
    sleep 0.3
fi

# --- Start backend ---
# Mark this as a dev launch so backend/run.sh enables --reload. Packaged
# builds never run this top-level script (Electron spawns backend
# directly), so the env stays unset in production and uvicorn boots in
# its leaner non-reload mode.
export OPENSWARM_DEV=1

# Opt-in dev telemetry. Dev normally never reports (the analytics client falls back to a dead local ingest); set OPENSWARM_ANALYTICS=1 (e.g. a hackathon cohort) to report to the prod edge, tagged with a -dev channel so those events stay filterable from real installs. Off by default so a stray `bash run.sh` never phones home.
if [ "${OPENSWARM_ANALYTICS:-0}" = "1" ]; then
    export OPENSWARM_ANALYTICS_URL="${OPENSWARM_ANALYTICS_URL:-https://analytics.openswarm.com}"
    export OPENSWARM_APP_CHANNEL="${OPENSWARM_APP_CHANNEL:-dev}"
fi

echo -e "${BLUE}${BOLD}[backend]${RESET}  Starting backend server..."
bash "$PROJECT_ROOT/backend/run.sh" > >(
    while IFS= read -r line; do
        printf "${BLUE}${BOLD}[backend]${RESET}  %s\n" "$line"
    done
) 2>&1 &
BACKEND_PID=$!

# --- Wait for backend to become healthy ---
echo -e "${YELLOW}${BOLD}Waiting for backend (http://localhost:${BACKEND_PORT}) to be ready...${RESET}"
MAX_WAIT=120
elapsed=0
while (( elapsed < MAX_WAIT )); do
    if curl -s -o /dev/null --connect-timeout 1 http://localhost:${BACKEND_PORT}/ 2>/dev/null; then
        echo -e "${GREEN}${BOLD}Backend is ready!${RESET}"
        break
    fi
    if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
        echo -e "${RED}${BOLD}Backend process exited before becoming ready.${RESET}"
        exit 1
    fi
    sleep 2
    ((elapsed += 2))
done

if (( elapsed >= MAX_WAIT )); then
    echo -e "${RED}${BOLD}Backend did not become ready within ${MAX_WAIT}s. Aborting.${RESET}"
    exit 1
fi

# --- Start frontend ---
echo -e "${GREEN}${BOLD}[frontend]${RESET} Starting frontend dev server..."
bash "$PROJECT_ROOT/frontend/run.sh" > >(
    while IFS= read -r line; do
        printf "${GREEN}${BOLD}[frontend]${RESET} %s\n" "$line"
    done
) 2>&1 &
FRONTEND_PID=$!

# --- Wait for frontend dev server to become available ---
echo -e "${YELLOW}${BOLD}Waiting for frontend (http://localhost:${FRONTEND_PORT}) to be ready...${RESET}"
FRONTEND_MAX_WAIT=60
frontend_elapsed=0
while (( frontend_elapsed < FRONTEND_MAX_WAIT )); do
    if curl -s -o /dev/null --connect-timeout 1 http://localhost:${FRONTEND_PORT}/ 2>/dev/null; then
        echo -e "${GREEN}${BOLD}Frontend is ready!${RESET}"
        break
    fi
    if ! kill -0 "$FRONTEND_PID" 2>/dev/null; then
        echo -e "${RED}${BOLD}Frontend process exited before becoming ready.${RESET}"
        exit 1
    fi
    sleep 2
    ((frontend_elapsed += 2))
done

if (( frontend_elapsed >= FRONTEND_MAX_WAIT )); then
    echo -e "${RED}${BOLD}Frontend did not become ready within ${FRONTEND_MAX_WAIT}s. Aborting.${RESET}"
    exit 1
fi

# --- Install Electron dependencies if needed ---
MAGENTA='\033[0;35m'
if [ ! -d "$PROJECT_ROOT/electron/node_modules" ]; then
    echo -e "${MAGENTA}${BOLD}[electron]${RESET} Installing dependencies..."
    (cd "$PROJECT_ROOT/electron" && npm install) 2>&1 | while IFS= read -r line; do
        printf "${MAGENTA}${BOLD}[electron]${RESET} %s\n" "$line"
    done
fi

# --- Sign Electron VMP for DRM (if EVS account exists) ---
if [ -f "$PROJECT_ROOT/electron/scripts/sign-vmp.sh" ]; then
    echo -e "${YELLOW}${BOLD}[vmp]${RESET}      Checking VMP signature..."
    bash "$PROJECT_ROOT/electron/scripts/sign-vmp.sh" 2>&1 | while IFS= read -r line; do
        printf "${YELLOW}${BOLD}%s${RESET}\n" "$line"
    done
fi

# --- Start Electron in dev mode ---
echo -e "${MAGENTA}${BOLD}[electron]${RESET} Launching Electron dev shell..."
(cd "$PROJECT_ROOT/electron" && unset ELECTRON_RUN_AS_NODE && ELECTRON_DEV=1 npx electron .) > >(
    while IFS= read -r line; do
        printf "${MAGENTA}${BOLD}[electron]${RESET} %s\n" "$line"
    done
) 2>&1 &
ELECTRON_PID=$!

echo ""
echo -e "${BOLD}All services are running. Press Ctrl+C to stop.${RESET}"
echo -e "  Backend:  ${BLUE}http://localhost:${BACKEND_PORT}${RESET}"
echo -e "  Frontend: ${GREEN}http://localhost:${FRONTEND_PORT}${RESET}"
echo -e "  Electron: ${MAGENTA}dev shell (pid $ELECTRON_PID)${RESET}"
echo ""

# --- Monitor: if any service exits, tear down all ---
while ! $SHUTTING_DOWN; do
    if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
        echo -e "${RED}${BOLD}Backend process exited unexpectedly. Shutting down...${RESET}"
        exit 1
    fi
    if [[ -n "$FRONTEND_PID" ]] && ! kill -0 "$FRONTEND_PID" 2>/dev/null; then
        echo -e "${RED}${BOLD}Frontend process exited unexpectedly. Shutting down...${RESET}"
        exit 1
    fi
    if [[ -n "$ELECTRON_PID" ]] && ! kill -0 "$ELECTRON_PID" 2>/dev/null; then
        echo -e "${YELLOW}${BOLD}Electron process exited. Shutting down...${RESET}"
        exit 0
    fi
    sleep 3
done
