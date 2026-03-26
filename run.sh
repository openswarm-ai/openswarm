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

# --- Start backend ---
echo -e "${BLUE}${BOLD}[backend]${RESET}  Starting backend server..."
bash "$PROJECT_ROOT/backend/run.sh" > >(
    while IFS= read -r line; do
        printf "${BLUE}${BOLD}[backend]${RESET}  %s\n" "$line"
    done
) 2>&1 &
BACKEND_PID=$!

# --- Wait for backend to become healthy ---
echo -e "${YELLOW}${BOLD}Waiting for backend (http://localhost:8324) to be ready...${RESET}"
MAX_WAIT=120
elapsed=0
while (( elapsed < MAX_WAIT )); do
    if curl -s -o /dev/null --connect-timeout 1 http://localhost:8324/ 2>/dev/null; then
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
echo -e "${YELLOW}${BOLD}Waiting for frontend (http://localhost:3000) to be ready...${RESET}"
FRONTEND_MAX_WAIT=60
frontend_elapsed=0
while (( frontend_elapsed < FRONTEND_MAX_WAIT )); do
    if curl -s -o /dev/null --connect-timeout 1 http://localhost:3000/ 2>/dev/null; then
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
echo -e "  Backend:  ${BLUE}http://localhost:8324${RESET}"
echo -e "  Frontend: ${GREEN}http://localhost:3000${RESET}"
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
