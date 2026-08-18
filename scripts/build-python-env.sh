#!/bin/bash
set -euo pipefail

# Build an embedded Python environment for the Electron app (macOS).
#
# Downloads a standalone Python build from python-build-standalone,
# creates a venv, and installs all backend dependencies.
#
# Usage: build-python-env.sh [arm64|x64]   (default: host arch)
#
# The env stages under electron/build-staging/python-env/<arch> so
# electron-builder's ${arch} macro bundles the MATCHING env per pack, same
# pattern as node/${arch}. Never bundle one host-arch env into both DMGs:
# that shipped arm64 python inside the x64 app and killed every Intel Mac.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
ELECTRON_DIR="$PROJECT_ROOT/electron"

PYTHON_VERSION="3.14"
PYTHON_FULL_VERSION="3.14.6"
ARCH="${1:-$(uname -m)}"

case "$ARCH" in
    arm64|aarch64) ARCH="arm64"; PLATFORM_TAG="aarch64-apple-darwin" ;;
    x64|x86_64)    ARCH="x64";   PLATFORM_TAG="x86_64-apple-darwin" ;;
    *) echo "Unsupported architecture: $ARCH"; exit 1 ;;
esac

PYTHON_ENV_DIR="$ELECTRON_DIR/build-staging/python-env/$ARCH"

# Cross-building x64 on Apple Silicon runs the x64 python under Rosetta
# (pip then resolves x86_64 wheels, including the SDK's bundled claude CLI).
if [[ "$ARCH" == "x64" && "$(uname -m)" == "arm64" ]]; then
    if ! arch -x86_64 /usr/bin/true 2>/dev/null; then
        echo "ERROR: building the x64 python-env on Apple Silicon requires Rosetta 2."
        echo "  Install it with: softwareupdate --install-rosetta --agree-to-license"
        exit 1
    fi
fi

RELEASE_TAG="20260623"
# The archive is pinned by digest so a moved or replaced release asset cannot ship a different interpreter.
case "$ARCH" in
    arm64) ARCHIVE_SHA256="35d774f61d63c1fd4f1bc9495a7ada92e500dc4382a0df8a9910eb87ea48e8cf" ;;
    x64)   ARCHIVE_SHA256="12fb3ea3d6a855fe6ca1c2241702b06cb7e5939fbef09a5f54bf326e480f66af" ;;
esac
TARBALL_NAME="cpython-${PYTHON_FULL_VERSION}+${RELEASE_TAG}-${PLATFORM_TAG}-install_only_stripped.tar.gz"
# python-build-standalone now lives under astral-sh; the '+' in the asset name must be URL-encoded.
DOWNLOAD_URL="https://github.com/astral-sh/python-build-standalone/releases/download/${RELEASE_TAG}/${TARBALL_NAME/+/%2B}"
TEMP_DIR="$(mktemp -d)"

cleanup() {
    rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

echo "=== Building Python Environment ==="
echo "Architecture: $ARCH ($PLATFORM_TAG)"
echo "Python: $PYTHON_FULL_VERSION"

# Remove old env if present
if [[ -d "$PYTHON_ENV_DIR" ]]; then
    echo "Removing old python-env..."
    rm -rf "$PYTHON_ENV_DIR"
fi
mkdir -p "$(dirname "$PYTHON_ENV_DIR")"

# Download standalone Python
echo "Downloading standalone Python from python-build-standalone..."
echo "URL: $DOWNLOAD_URL"
curl -fSL --progress-bar -o "$TEMP_DIR/python.tar.gz" "$DOWNLOAD_URL"
ACTUAL_SHA256="$(shasum -a 256 "$TEMP_DIR/python.tar.gz" | awk '{print $1}')"
if [[ "$ACTUAL_SHA256" != "$ARCHIVE_SHA256" ]]; then
    echo "ERROR: standalone Python archive SHA-256 mismatch: expected $ARCHIVE_SHA256, got $ACTUAL_SHA256" >&2
    exit 1
fi
echo "Standalone Python SHA-256 verified: $ACTUAL_SHA256"

echo "Extracting..."
tar xzf "$TEMP_DIR/python.tar.gz" -C "$TEMP_DIR"

# The tarball extracts to python/
EXTRACTED_DIR="$TEMP_DIR/python"
if [[ ! -d "$EXTRACTED_DIR" ]]; then
    echo "Error: Expected extracted directory at $EXTRACTED_DIR"
    ls -la "$TEMP_DIR"
    exit 1
fi

# Move into place
mv "$EXTRACTED_DIR" "$PYTHON_ENV_DIR"
echo "Python installed to $PYTHON_ENV_DIR"

PYTHON_BIN="$PYTHON_ENV_DIR/bin/python${PYTHON_VERSION}"
if [[ ! -f "$PYTHON_BIN" ]]; then
    PYTHON_BIN="$PYTHON_ENV_DIR/bin/python3"
fi

echo "Python binary: $PYTHON_BIN"
"$PYTHON_BIN" --version

# Install pip (standalone builds may not include it)
if ! "$PYTHON_BIN" -m pip --version &>/dev/null; then
    echo "Installing pip..."
    "$PYTHON_BIN" -m ensurepip --upgrade
fi

# Install backend dependencies from the fully-pinned, hash-locked file so the
# shipped python-env is byte-for-byte reproducible (pillar 3). requirements.txt
# is the human-edited source; regenerate the lock after editing it with:
#   uv pip compile backend/requirements.txt --python-version 3.14 \
#       --generate-hashes --output-file backend/requirements.lock
# --require-hashes is implied because every entry carries a hash.
echo "Installing backend dependencies (from requirements.lock)..."
"$PYTHON_BIN" -m pip install --upgrade pip
"$PYTHON_BIN" -m pip install -r "$PROJECT_ROOT/backend/requirements.lock"

# Verify claude-agent-sdk and its bundled binary
echo "Verifying claude-agent-sdk..."
"$PYTHON_BIN" -c "import claude_agent_sdk; print(f'claude-agent-sdk installed')"

CLAUDE_BIN=$("$PYTHON_BIN" -c "
from pathlib import Path
import claude_agent_sdk
sdk_dir = Path(claude_agent_sdk.__file__).parent
bundled = sdk_dir / '_bundled' / 'claude'
print(bundled)
")
if [[ -f "$CLAUDE_BIN" ]]; then
    echo "Claude binary found: $CLAUDE_BIN"
    chmod +x "$CLAUDE_BIN"
else
    echo "WARNING: Claude binary not found at $CLAUDE_BIN"
fi

# Clean up build artifacts to reduce size. Drop test packages and any
# stale __pycache__/.pyc from the upstream Python tarball — we want our
# own freshly-compiled bytecode (next step), not whatever the upstream
# build happened to ship.
echo "Cleaning up..."
find "$PYTHON_ENV_DIR" -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true
find "$PYTHON_ENV_DIR" -name "*.pyc" -delete 2>/dev/null || true
find "$PYTHON_ENV_DIR" -type d -name "tests" -exec rm -rf {} + 2>/dev/null || true
find "$PYTHON_ENV_DIR" -type d -name "test" -exec rm -rf {} + 2>/dev/null || true

# Strip parts of the Python distribution we provably don't use at runtime.
# Each removal here has been individually verified.
echo "Stripping unused Python distribution files..."
# C headers — only needed when building C extensions, never at runtime.
rm -rf "$PYTHON_ENV_DIR/include"
# IDLE editor + Tk GUI toolkit — embedded headless backend has no UI.
rm -rf "$PYTHON_ENV_DIR/lib/python3.14/idlelib"
rm -rf "$PYTHON_ENV_DIR/lib/python3.14/tkinter"
# ensurepip stays: the App Builder runs `python -m venv` with THIS interpreter
# for every generated app's backend and for the shared warm venv (run.sh gets it
# as OPENSWARM_PYTHON; view_builder_templates uses sys.executable), and venv
# bootstraps pip into the new environment from ensurepip's bundled wheel.
# Without it the venv step fails and no generated backend can start. ~1.8 MB.
# Educational drawing examples that ship with stdlib — never imported.
rm -rf "$PYTHON_ENV_DIR/lib/python3.14/turtledemo"
# turtle itself: a Tk-based graphics module. It imports tkinter (stripped
# above), so it's already non-functional here, and the backend never uses it.
rm -rf "$PYTHON_ENV_DIR/lib/python3.14/turtle.py"
# Man pages / desktop-integration files — embedded Python doesn't read these.
rm -rf "$PYTHON_ENV_DIR/share"
# pip itself + launcher shims. Nothing in the packaged backend runs the
# bundled pip: uvx (used by MCPs) is a self-contained installer, and the venvs
# the App Builder creates get their own pip from ensurepip (kept above), not
# from this copy; backend code only mentions "pip install" in error-message
# strings.
rm -rf "$PYTHON_ENV_DIR/lib/python3.14/site-packages/pip" \
       "$PYTHON_ENV_DIR/lib/python3.14/site-packages"/pip-*.dist-info
rm -f "$PYTHON_ENV_DIR/bin/pip" "$PYTHON_ENV_DIR/bin/pip3" "$PYTHON_ENV_DIR/bin/pip3.14" \
      "$PYTHON_ENV_DIR/bin/idle3" "$PYTHON_ENV_DIR/bin/idle3.14" \
      "$PYTHON_ENV_DIR/bin/pydoc3" "$PYTHON_ENV_DIR/bin/pydoc3.14"
# pydoc_data: keyword/topic tables consumed only by stdlib `pydoc` / `help()`.
# Backend never starts a REPL or calls help().
rm -rf "$PYTHON_ENV_DIR/lib/python3.14/pydoc_data"
# _pyrepl: the interactive REPL implementation (new in 3.13). We never
# spawn an interactive shell from the packaged build.
rm -rf "$PYTHON_ENV_DIR/lib/python3.14/_pyrepl"
# Tcl/Tk runtime shared libraries. python-build-standalone install_only_stripped
# ships these even after the `tkinter` Python package is stripped. With the
# `_tkinter` C extension absent (lib-dynload/ is empty in this build variant;
# verified `find python-env -name '_tkinter*.so'` returns nothing), no code
# path can load these libraries. PIL.ImageTk would import them but backend
# only does `from PIL import Image`, never ImageTk.
rm -rf "$PYTHON_ENV_DIR/lib/tcl8.6" "$PYTHON_ENV_DIR/lib/tk8.6" \
       "$PYTHON_ENV_DIR/lib/itcl4.2.4" "$PYTHON_ENV_DIR/lib/thread2.8.9" \
       "$PYTHON_ENV_DIR/lib/tcl8"

# ----- Babel locale-data trim (~30 MB / ~900 files) -----
# Babel ships 1,084 CLDR locale .dat files (~30 MB). Our backend doesn't use
# babel directly, but trafilatura's transitive dep `courlan/filters.py:184`
# calls `Locale.parse(seg)` on URL path segments — if a stripped locale's
# .dat is missing courlan raises `UnknownLocaleError`, which IS caught at
# line 188 (graceful degradation: that URL just doesn't get language-
# filtered). Even so, keeping the most-common 20 base languages preserves
# language detection for the URLs we'll actually see in practice.
SP="$PYTHON_ENV_DIR/lib/python3.14/site-packages"
if [[ -d "$SP/babel/locale-data" ]]; then
    echo "Trimming babel/locale-data..."
    LOCALE_DIR="$SP/babel/locale-data"
    # Keep:
    #  - root.dat                — fallback for unknown locales
    #  - LICENSE.unicode         — required by Unicode/CLDR license
    #  - en*.dat                 — every English variant (130 files; small)
    #  - <lang>.dat for the 20 most common base languages we'd plausibly see
    #    in URL path segments. Country-suffix variants (fr_CA.dat, de_AT.dat
    #    etc.) get dropped — courlan only uses .language so the base is enough.
    KEEP_LANGS="ar de es fr it ja ko nl pl pt ru sv tr zh hi th vi id da no fi cs el he uk"
    # Build a regex of "files to KEEP" so find can delete the rest.
    KEEP_RE='^(root\.dat|LICENSE\.unicode|en($|_).*\.dat'
    for L in $KEEP_LANGS; do KEEP_RE="$KEEP_RE|${L}\.dat"; done
    KEEP_RE="$KEEP_RE)$"
    # Find every file in locale-data that DOESN'T match KEEP_RE and delete it.
    find "$LOCALE_DIR" -maxdepth 1 -type f \
        | awk -v re="$KEEP_RE" 'BEGIN { FS="/" } { if ($NF !~ re) print }' \
        | xargs -r -n 50 rm -f
fi

# ----- dist-info noise trim (~2 MB / ~280 files) -----
# pip metadata that's only consulted by pip itself (which we don't run at
# runtime). RECORD/INSTALLER/WHEEL/entry_points.txt/top_level.txt have zero
# runtime readers in our shipped deps. METADATA we KEEP — some packages and
# transitive deps occasionally call importlib.metadata.metadata("pkg").
echo "Trimming pip dist-info noise..."
find "$SP" -path '*.dist-info/RECORD'         -delete 2>/dev/null
find "$SP" -path '*.dist-info/INSTALLER'      -delete 2>/dev/null
find "$SP" -path '*.dist-info/WHEEL'          -delete 2>/dev/null
find "$SP" -path '*.dist-info/top_level.txt'  -delete 2>/dev/null
find "$SP" -path '*.dist-info/entry_points.txt' -delete 2>/dev/null

# ----- type stubs + build leftovers (more files off Defender's plate) -----
# .pyi stubs are read only by type-checkers, never by the running interpreter.
find "$PYTHON_ENV_DIR" -name '*.pyi' -delete 2>/dev/null || true
# Unix build artifacts: the static lib + config Makefiles exist only to compile
# C extensions / embed Python; the running interpreter never reads them.
rm -rf "$PYTHON_ENV_DIR"/lib/python3.14/config-3.14-* 2>/dev/null || true
find "$PYTHON_ENV_DIR" -name 'libpython*.a' -delete 2>/dev/null || true

# The trimmed interpreter must still be able to do the one install-time job the
# App Builder asks of it: create a venv that has pip (see the ensurepip note
# above). Checked here, after every trim, so a future strip cannot silently
# take it away again.
echo "Verifying the trimmed interpreter can create a venv with pip..."
VENV_PROBE="$(mktemp -d "${TMPDIR:-/tmp}/python-env-venv-probe.XXXXXX")"
if ! PYTHONNOUSERSITE=1 "$PYTHON_BIN" -m venv "$VENV_PROBE/venv" \
   || ! "$VENV_PROBE/venv/bin/python" -m pip --version >/dev/null; then
    rm -rf "$VENV_PROBE"
    echo "ERROR: the trimmed python-env cannot create a venv with pip; generated app backends need this." >&2
    exit 1
fi
rm -rf "$VENV_PROBE"

# Pre-compile bytecode so cold backend startup skips the parse+compile
# step on every imported .py. Worth ~5-10s on Windows under Defender
# (parsing Python source is parser-bound; loading .pyc is just bytes).
# Concurrency capped at 4 — `-j 0` (all cores) is fine on dev boxes
# but unstable on small CI runners. Failures on individual files are
# survivable (compileall continues on SyntaxError-tagged files used by
# version-shim packages); a non-zero exit here would rather be visible
# than silent so we don't `|| true` the whole thing — but missing .pyc
# is non-fatal at runtime, so a hard fail isn't warranted either.
# invalidation-mode unchecked-hash: default timestamp mode ties each .pyc to its
# source mtime, which installers rewrite on extract, silently invalidating every
# .pyc so Python recompiles from source on every launch. unchecked-hash is mtime-
# independent (correct for a frozen bundle), so the precompiled .pyc actually get used.
echo "Pre-compiling bytecode..."
"$PYTHON_BIN" -m compileall -q -j 4 --invalidation-mode unchecked-hash "$PYTHON_ENV_DIR/lib" || \
    echo "WARNING: some files failed to compile; runtime will fall back to in-memory compile."

# ----- macOS: hide bundled python from the Dock -----
# python-build-standalone ships a bare Mach-O at bin/python3.14 with NO
# embedded __TEXT,__info_plist section, but libpython3.14.dylib is linked
# against AppKit / Cocoa / ApplicationServices. On a fresh user Mac (with
# .app quarantine attrs + first-launch XProtect inspection), spawning that
# binary from Electron causes LaunchServices to register it as a generic
# bundleless GUI process and render the macOS "exec" placeholder dock icon
# (bouncing for the entire boot window). Wrapping the binary in a tiny .app
# whose Info.plist sets LSUIElement=1 tells LaunchServices to skip the dock
# entry entirely. Python.org's framework Python uses the same trick.
#
# Invariants this layout depends on (don't break them):
#   - codesign rejects symlinks as CFBundleExecutable ("the main executable
#     or Info.plist must be a regular file (no symlinks, etc.)") — so
#     python3 inside Python.app MUST be a real Mach-O copy, not a symlink.
#     We copy bin/python3.14 in and rewrite its LC_LOAD_DYLIB so it still
#     finds the single libpython3.14.dylib at python-env/lib/.
#   - Python.getpath() calls realpath() on argv[0], so sys.prefix still
#     resolves to python-env/ even though the launcher lives inside the
#     wrapper bundle. All stdlib + site-packages discovery is unchanged.
#   - The launcher binary is tiny (~50 KB), so the duplicate copy is
#     negligible. We deliberately do NOT duplicate libpython3.14.dylib
#     (~18 MB) — only the launcher.
if [[ "$(uname)" == "Darwin" ]]; then
    echo "Creating Python.app launcher (LSUIElement=1, hides from Dock)..."
    PY_APP="$PYTHON_ENV_DIR/Python.app"
    rm -rf "$PY_APP"
    mkdir -p "$PY_APP/Contents/MacOS"
    cat > "$PY_APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>python3</string>
  <key>CFBundleIdentifier</key>
  <string>com.clusterlabs.openswarm.python</string>
  <key>CFBundleName</key>
  <string>OpenSwarm Backend</string>
  <key>CFBundleDisplayName</key>
  <string>OpenSwarm Backend</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>3.14</string>
  <key>CFBundleVersion</key>
  <string>3.14</string>
  <key>LSUIElement</key>
  <true/>
</dict>
</plist>
PLIST
    # Copy the launcher binary into the bundle. codesign requires a
    # regular file here (symlinks are rejected outright). Then rewrite
    # the LC_LOAD_DYLIB so @executable_path resolves correctly from
    # Python.app/Contents/MacOS/ — three levels up reaches python-env/,
    # then ../lib gets us to libpython3.14.dylib without duplication.
    cp "$PYTHON_ENV_DIR/bin/python3.14" "$PY_APP/Contents/MacOS/python3"
    chmod +x "$PY_APP/Contents/MacOS/python3"
    # The 3.14 python-build-standalone launcher is statically linked and carries no libpython load
    # command; only rewrite the dylib path when a build actually links it (getpath() still finds the
    # prefix by walking up from the copied launcher either way).
    if otool -L "$PY_APP/Contents/MacOS/python3" | grep -q "libpython3.14.dylib"; then
        install_name_tool \
            -change "@executable_path/../lib/libpython3.14.dylib" \
                    "@executable_path/../../../lib/libpython3.14.dylib" \
            "$PY_APP/Contents/MacOS/python3"
    fi
    # install_name_tool invalidates the existing adhoc signature; re-sign
    # ad-hoc so the binary loads cleanly during the build's self-test.
    # electron-builder's full sign pass will replace this with a proper
    # Developer ID signature later.
    codesign --force --sign - "$PY_APP/Contents/MacOS/python3" 2>/dev/null

    # Sanity-check: the wrapper actually runs, sys.prefix resolves to
    # python-env/ via realpath, and libpython loads via the rewritten
    # @executable_path path.
    if ! "$PY_APP/Contents/MacOS/python3" -c \
            "import sys, os; assert os.path.realpath(sys.prefix) == os.path.realpath('$PYTHON_ENV_DIR'), sys.prefix" 2>/dev/null; then
        echo "ERROR: Python.app wrapper failed self-test (libpython or stdlib not findable)" >&2
        echo "  Try: $PY_APP/Contents/MacOS/python3 -c 'import sys; print(sys.prefix)'" >&2
        exit 1
    fi
    echo "Python.app wrapper installed at $PY_APP"
fi

TOTAL_SIZE=$(du -sh "$PYTHON_ENV_DIR" | cut -f1)
PYC_COUNT=$(find "$PYTHON_ENV_DIR" -name '*.pyc' -type f | wc -l | tr -d ' ')
echo ""
echo "=== Python Environment Ready ==="
echo "Location: $PYTHON_ENV_DIR"
echo "Size: $TOTAL_SIZE ($PYC_COUNT .pyc files)"
echo ""
