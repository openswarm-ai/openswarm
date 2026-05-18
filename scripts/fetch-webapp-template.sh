#!/usr/bin/env bash
# Re-vendor openswarm-ai/webapp-template into backend/apps/outputs/webapp_template/.
#
# Idempotent: wipes the existing vendored dir and re-clones at the pinned ref.
# Strips files we don't want shipped (LICENSE, README.md, .gitignore; we author our own minimal .gitignore). Applies two patches:
#   1. backend/run.sh: pip-install $OPENSWARM_DEBUGGER_PATH before the existing `pip install -e .` to resolve the `swarm-debug` dep from OpenSwarm's bundled debugger/.
#   2. Add our own backend_init.sh at the snapshot root.
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

# Patch 1: backend/run.sh installs OpenSwarm's local debugger/ before the
# template's own `pip install -e .` so `from swarm_debug import debug` in
# the template's backend code resolves to our bundled package (the PyPI
# `swarm-debug` doesn't exist; our local package registers as `debug`
# and exposes both `debug` and `swarm_debug` module names via setup.py
# py_modules).
RUN_SH="$DEST/backend/run.sh"
if ! grep -q "OPENSWARM_DEBUGGER_PATH" "$RUN_SH"; then
    # Insert the install line just before `pip install -e .`. macOS sed
    # vs GNU sed: use a portable awk inline rewrite.
    awk '
        /pip install -e \./ && !inserted {
            print "if [[ -n \"${OPENSWARM_DEBUGGER_PATH:-}\" && -d \"$OPENSWARM_DEBUGGER_PATH\" ]]; then"
            print "    echo \"Installing OpenSwarm debugger (swarm_debug) from $OPENSWARM_DEBUGGER_PATH\""
            print "    pip install -e \"$OPENSWARM_DEBUGGER_PATH\""
            print "fi"
            inserted = 1
        }
        { print }
    ' "$RUN_SH" > "$RUN_SH.tmp" && mv "$RUN_SH.tmp" "$RUN_SH"
    chmod +x "$RUN_SH"
fi

# Patch 1b: drop `"swarm-debug"` from the template's backend/pyproject.toml
# dependencies. The OpenSwarm debugger gets installed separately via Patch
# 1's `pip install -e $OPENSWARM_DEBUGGER_PATH`. Leaving the dep listed
# would make pip 404 against PyPI (no such package).
PYPROJECT="$DEST/backend/pyproject.toml"
awk '
    /^[[:space:]]*"swarm-debug",?[[:space:]]*$/ { next }
    { print }
' "$PYPROJECT" > "$PYPROJECT.tmp" && mv "$PYPROJECT.tmp" "$PYPROJECT"

# Patch 1c: vite.config.ts: pin host to 127.0.0.1 (so our IPv4-only
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
EOF

# Patch 3: backend_init.sh, copied verbatim into every new workspace.
# We author this ourselves (not upstream) because the user spec says the
# agent runs it to *bring in* the backend dir on demand; the initial seed
# leaves backend/ out.
cat > "$DEST/backend_init.sh" <<'EOF'
#!/usr/bin/env bash
# Enable a FastAPI backend for this App.
#
# Idempotent. The workspace is seeded frontend-only (no backend/ dir,
# BACKEND_PORT=NONE). Run this script when your App needs server-side
# code; it copies the master template's backend/ into the workspace
# and flips BACKEND_PORT in both .env files to a free port.
#
# After running this, hard-reload the preview (right-click the reload
# button in the App Builder) so the runtime restarts with the new
# BACKEND_PORT and `bash run.sh` brings the backend up.

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

if [[ ! -f .env ]]; then
    echo "ERROR: .env not found at $HERE. Is this the workspace root?" >&2
    exit 1
fi

# Source .env so we know the current BACKEND_PORT and the path to the
# master template's backend/ (written by OpenSwarm at seed time).
set -a
source .env
set +a

if [[ "${BACKEND_PORT:-NONE}" != "NONE" ]]; then
    echo "Backend already enabled on port $BACKEND_PORT, nothing to do." >&2
    exit 0
fi

if [[ -d ./backend ]]; then
    echo "ERROR: ./backend/ already exists but BACKEND_PORT=NONE; your" >&2
    echo "       workspace is in an inconsistent state. Either delete" >&2
    echo "       ./backend/ and re-run, or set BACKEND_PORT manually." >&2
    exit 1
fi

# Resolve master template backend/ path. OPENSWARM_TEMPLATE_BACKEND_PATH
# is written into .env at seed time; OPENSWARM_DEBUGGER_PATH the same.
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
echo "Hard-reload the preview (right-click the reload button in"
echo "the App Builder) to bring it up."
EOF
chmod +x "$DEST/backend_init.sh"

echo ""
echo "[fetch-webapp-template] vendored snapshot at $DEST"
echo "[fetch-webapp-template] pinned ref: $REF"
echo "[fetch-webapp-template] file count: $(find "$DEST" -type f | wc -l | tr -d ' ')"
