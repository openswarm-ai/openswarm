#!/usr/bin/env bash
# Re-vendor openswarm-ai/webapp-template into backend/apps/outputs/webapp_template/.
#
# Idempotent — wipes the existing vendored dir and re-clones at the pinned ref.
# Strips files we don't want shipped (LICENSE, README.md, .gitignore — we
# author our own minimal .gitignore inside the snapshot). Applies our
# patches (swarm-debug toggle-on at boot, vite config pinning, .gitignore,
# backend_init.sh). The template's `swarm-debug` dependency now resolves
# from PyPI like any other dep; the old local-debugger injection patches
# (editable-install of the bundled debugger/) are gone.
#
# Update REF to bump the pinned snapshot. CI / a future test could compare
# `git rev-parse HEAD` of a fresh clone against REF and fail on drift.

set -euo pipefail

REPO="openswarm-ai/webapp-template"
REF="main"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/backend/apps/outputs/webapp_template"
TMP="$(mktemp -d)"

cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

echo "[fetch-webapp-template] cloning $REPO@$REF into $TMP"
git clone --depth 1 --branch "$REF" "https://github.com/$REPO.git" "$TMP/clone" >/dev/null

# Wipe the vendored dir cleanly so deleted upstream files actually leave.
rm -rf "$DEST"
mkdir -p "$DEST"

# Copy everything except files we don't ship in OpenSwarm.
( cd "$TMP/clone" && rm -rf .git LICENSE README.md .gitignore )
cp -R "$TMP/clone/." "$DEST/"

# Patch 1a: root run.sh honors per-instance port overrides. OpenSwarm passes
# OPENSWARM_FORCE_FRONTEND_PORT / OPENSWARM_FORCE_BACKEND_PORT when the user
# opens a SECOND instance of an app; without this the `source .env` above
# them pins every instance to the same ports.
ROOT_RUN_SH="$DEST/run.sh"
if ! grep -q "OPENSWARM_FORCE_FRONTEND_PORT" "$ROOT_RUN_SH"; then
    awk '
        inserted != 1 && sourced && /^fi$/ {
            print
            print ""
            print "# Per-instance port overrides: OpenSwarm passes these when the user opens a SECOND instance of the app, so it boots on fresh ports instead of colliding with the primary'\''s .env-pinned ones."
            print "if [[ -n \"${OPENSWARM_FORCE_FRONTEND_PORT:-}\" ]]; then"
            print "    export FRONTEND_PORT=\"$OPENSWARM_FORCE_FRONTEND_PORT\""
            print "fi"
            print "if [[ -n \"${OPENSWARM_FORCE_BACKEND_PORT:-}\" ]]; then"
            print "    export BACKEND_PORT=\"$OPENSWARM_FORCE_BACKEND_PORT\""
            print "fi"
            inserted = 1
            next
        }
        /source "\$ROOT_DIR\/.env"/ { sourced = 1 }
        { print }
    ' "$ROOT_RUN_SH" > "$ROOT_RUN_SH.tmp" && mv "$ROOT_RUN_SH.tmp" "$ROOT_RUN_SH"
    chmod +x "$ROOT_RUN_SH"
fi

# Patch 1: backend/run.sh forces all swarm-debug per-file toggles ON at
# every boot (they default OFF, including files the agent creates later),
# so `debug()` output actually lands in the App Builder Terminal. Runs
# from the workspace root because that's uvicorn's cwd = the package's
# per-project data-dir key.
RUN_SH="$DEST/backend/run.sh"
if ! grep -q "swarm-debug gates output" "$RUN_SH"; then
    awk '
        /^echo "Starting backend server/ && !inserted {
            print "# swarm-debug gates output on per-file toggles that default OFF; force all ON each boot so agent-added files show in the Terminal."
            print "if [[ \"$IS_WIN\" == \"1\" ]]; then SWARM_DEBUG_BIN=\"$VENV_DIR/Scripts/swarm-debug.exe\"; else SWARM_DEBUG_BIN=\"$VENV_DIR/bin/swarm-debug\"; fi"
            print "( cd \"$BACKEND_DIR_ABSPATH/..\" && \"$SWARM_DEBUG_BIN\" toggle on --all >/dev/null 2>&1 ) || true"
            print ""
            inserted = 1
        }
        { print }
    ' "$RUN_SH" > "$RUN_SH.tmp" && mv "$RUN_SH.tmp" "$RUN_SH"
    chmod +x "$RUN_SH"
fi

# Patch 1c: vite.config.ts — pin host to 127.0.0.1 (so our IPv4-only
# bind poller in runtime.py:_await_frontend_bind() actually sees the
# bound socket on macOS, where `localhost` can resolve to ::1), disable
# Vite's `open: true` browser auto-launch (preview belongs in the
# OpenSwarm webview, not a popped-out Chrome tab), and set strictPort
# so Vite doesn't silently increment to a port we're not polling.
VITE_CONFIG="$DEST/frontend/vite.config.ts"
if ! grep -q "host: '127.0.0.1'" "$VITE_CONFIG"; then
    awk '
        /server: \{/ && !patched {
            print
            print "      host: '\''127.0.0.1'\'',"
            patched_server = 1
            next
        }
        patched_server && /open: true/ {
            sub(/open: true/, "open: false")
            patched_server = 0
            patched = 1
        }
        { print }
    ' "$VITE_CONFIG" > "$VITE_CONFIG.tmp" && mv "$VITE_CONFIG.tmp" "$VITE_CONFIG"
    # Add strictPort right after the port line.
    awk '
        /port: Number\(process\.env\.FRONTEND_PORT\)/ && !inserted {
            print
            print "      strictPort: true,"
            inserted = 1
            next
        }
        { print }
    ' "$VITE_CONFIG" > "$VITE_CONFIG.tmp" && mv "$VITE_CONFIG.tmp" "$VITE_CONFIG"
fi

# Patch 2: ship a minimal .gitignore inside the snapshot so per-app
# workspaces don't accidentally commit node_modules / .env / venv.
cat > "$DEST/.gitignore" <<'EOF'
.DS_Store
.env
node_modules/
.venv/
__pycache__/
*.pyc
dist/
build/
.openswarm/
EOF

# Patch 3: backend_init.sh — copied verbatim into every new workspace.
# We author this ourselves (not upstream) because the user spec says the
# agent runs it to *bring in* the backend dir on demand; the initial seed
# leaves backend/ out.
cat > "$DEST/backend_init.sh" <<'EOF'
#!/usr/bin/env bash
# Enable a FastAPI backend for this App.
#
# Idempotent. The workspace is seeded frontend-only (no backend/ dir,
# BACKEND_PORT=NONE). Run this script when your App needs server-side
# code — it copies the master template's backend/ into the workspace
# and flips BACKEND_PORT in both .env files to a free port.
#
# After running this, run `bash restart.sh` so the runtime restarts
# with the new BACKEND_PORT and `bash run.sh` brings the backend up.

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

if [[ ! -f .env ]]; then
    echo "ERROR: .env not found at $HERE — is this the workspace root?" >&2
    exit 1
fi

# Source .env so we know the current BACKEND_PORT and the path to the
# master template's backend/ (written by OpenSwarm at seed time).
set -a
source .env
set +a

if [[ "${BACKEND_PORT:-NONE}" != "NONE" ]]; then
    echo "Backend already enabled on port $BACKEND_PORT — nothing to do." >&2
    exit 0
fi

if [[ -d ./backend ]]; then
    echo "ERROR: ./backend/ already exists but BACKEND_PORT=NONE — your" >&2
    echo "       workspace is in an inconsistent state. Either delete" >&2
    echo "       ./backend/ and re-run, or set BACKEND_PORT manually." >&2
    exit 1
fi

# Resolve master template backend/ path. OPENSWARM_TEMPLATE_BACKEND_PATH
# is written into .env at seed time.
if [[ -z "${OPENSWARM_TEMPLATE_BACKEND_PATH:-}" ]]; then
    echo "ERROR: OPENSWARM_TEMPLATE_BACKEND_PATH not set in .env. This" >&2
    echo "       workspace was seeded by an older OpenSwarm; ask the" >&2
    echo "       App Builder to recreate it." >&2
    exit 1
fi

if [[ ! -d "$OPENSWARM_TEMPLATE_BACKEND_PATH" ]]; then
    echo "ERROR: master template backend dir not found at" >&2
    echo "       $OPENSWARM_TEMPLATE_BACKEND_PATH" >&2
    exit 1
fi

echo "Copying backend/ from $OPENSWARM_TEMPLATE_BACKEND_PATH..."
cp -R "$OPENSWARM_TEMPLATE_BACKEND_PATH" ./backend
chmod +x ./backend/run.sh

# Pick a free port. SO_REUSEADDR=0 means the kernel won't immediately
# recycle, so the small race between bind+close and the backend
# re-binding is harmless in practice.
PORT="$(python3 -c "import socket
s = socket.socket()
s.bind(('127.0.0.1', 0))
print(s.getsockname()[1])
s.close()")"

# sed-flip both .env and .env.example so an LLM reading either gets the
# same answer. macOS sed needs the '' arg for in-place edits.
if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' "s/^BACKEND_PORT=NONE/BACKEND_PORT=$PORT/" .env
    sed -i '' "s/^BACKEND_PORT=NONE/BACKEND_PORT=$PORT/" .env.example
else
    sed -i "s/^BACKEND_PORT=NONE/BACKEND_PORT=$PORT/" .env
    sed -i "s/^BACKEND_PORT=NONE/BACKEND_PORT=$PORT/" .env.example
fi

echo ""
echo "Backend enabled on port $PORT."
echo "Run 'bash restart.sh' to bring it up (restarts the app runtime)."
EOF
chmod +x "$DEST/backend_init.sh"

# Patch 4: restart.sh — the agent-facing runtime restart. The runtime is
# owned by the OpenSwarm harness, so agents can't bounce it from Bash;
# this writes the sentinel the AppRuntimeManager watcher consumes
# (runtime.py RESTART_SENTINEL_NAME) and waits for pickup.
cat > "$DEST/restart.sh" <<'EOF'
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
EOF
chmod +x "$DEST/restart.sh"

echo ""
echo "[fetch-webapp-template] vendored snapshot at $DEST"
echo "[fetch-webapp-template] pinned ref: $REF"
echo "[fetch-webapp-template] file count: $(find "$DEST" -type f | wc -l | tr -d ' ')"
