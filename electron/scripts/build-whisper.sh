#!/bin/bash
# Build whisper.cpp's whisper-server for one arch and stage it where electron-builder's
# extraResources picks it up (build-staging/whisper/<arch>). The packaged app resolves it at
# resources/whisper/whisper-server (electron/voice/whisperService.js resolveBinary); the model
# stays a first-run download (ships +0MB, whisperService owns the fetch + progress UI).
# The brew binary can't be bundled: it links homebrew dylibs that don't exist on user machines.
set -euo pipefail

ARCH="${1:?usage: build-whisper.sh <arm64|x64>}"

WHISPER_VERSION="v1.7.6"
HERE="$(cd "$(dirname "$0")/.." && pwd)"   # electron/
OUT="$HERE/build-staging/whisper/$ARCH"
SRC="$HERE/build-staging/whisper-src"

MODEL_FILE="ggml-small.en-q5_1.bin"
MODEL_SHA="bfdff4894dcb76bbf647d56263ea2a96645423f1669176f4844a1bf8e478ad30"
MODEL_SRC="$(cd "$(dirname "$0")/.." && pwd)/whisper/$MODEL_FILE"
MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$MODEL_FILE"


# Idempotent across publish reruns: a staged binary from the same pinned version is reused. The MODEL
# has to be part of that condition, or a rerun whose binary is cached exits here and stages no model.
if [[ -f "$OUT/whisper-server" && -f "$OUT/.version" && "$(cat "$OUT/.version")" == "$WHISPER_VERSION" \
      && ( -f "$OUT/$MODEL_FILE" || "${OPENSWARM_SKIP_WHISPER_MODEL:-}" == "1" ) ]]; then
    echo "[whisper] $ARCH already staged at $WHISPER_VERSION, skipping"
    exit 0
fi

# The binary may be cached while the model is not, so building it again is wasted work; jump ahead.
if [[ -f "$OUT/whisper-server" && -f "$OUT/.version" && "$(cat "$OUT/.version")" == "$WHISPER_VERSION" ]]; then
    echo "[whisper] $ARCH binary already staged; model missing, staging that only"
    SKIP_BUILD=1
fi

if [[ "${SKIP_BUILD:-}" != "1" ]]; then
if [[ ! -d "$SRC/.git" ]]; then
    git clone --depth 1 --branch "$WHISPER_VERSION" https://github.com/ggml-org/whisper.cpp "$SRC"
else
    CUR="$(git -C "$SRC" describe --tags --exact-match 2>/dev/null || echo none)"
    if [[ "$CUR" != "$WHISPER_VERSION" ]]; then
        git -C "$SRC" fetch --depth 1 origin tag "$WHISPER_VERSION"
        git -C "$SRC" checkout -f "$WHISPER_VERSION"
    fi
fi

case "$ARCH" in
    arm64) OSX_ARCH="arm64";  EXTRA=(-DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON) ;;
    # Intel slice: CPU + Accelerate only. Metal shaders target Apple Silicon, and GGML_NATIVE
    # would bake this arm64 build host's flags into a cross build.
    x64)   OSX_ARCH="x86_64"; EXTRA=(-DGGML_METAL=OFF -DGGML_NATIVE=OFF) ;;
    *) echo "unknown arch: $ARCH"; exit 1 ;;
esac

BUILD_DIR="$SRC/build-$ARCH"
echo "[whisper] building whisper-server $WHISPER_VERSION for $ARCH..."
cmake -S "$SRC" -B "$BUILD_DIR" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_OSX_ARCHITECTURES="$OSX_ARCH" \
    -DBUILD_SHARED_LIBS=OFF \
    -DWHISPER_BUILD_TESTS=OFF \
    "${EXTRA[@]}" > /dev/null
cmake --build "$BUILD_DIR" --target whisper-server -j "$(sysctl -n hw.ncpu)" > /dev/null

BIN="$BUILD_DIR/bin/whisper-server"
[[ -f "$BIN" ]] || { echo "[whisper] build produced no whisper-server"; exit 1; }

mkdir -p "$OUT"
cp "$BIN" "$OUT/whisper-server"
echo "$WHISPER_VERSION" > "$OUT/.version"
echo "[whisper] staged -> $OUT/whisper-server"
file "$OUT/whisper-server"
# A binary that links anything outside the OS is a launch crash on user machines; fail loud here.
if otool -L "$OUT/whisper-server" | grep -qE "/opt/homebrew|/usr/local"; then
    echo "[whisper] ERROR: binary links non-system libraries"; otool -L "$OUT/whisper-server"; exit 1
fi
fi

# Bundle the default dictation model so fn works the instant the app opens, with no network at all.
# resolveModelFile (voice/whisperModels.js) already looks for DEFAULT_MODEL_ID here in resourceDir
# before anything in userData, so staging the file is the whole change. Costs ~181MB in the DMG;
# the alternative is a user pressing fn into silence while 190MB downloads behind them.
# Fetch it if it is not here. electron/whisper/ is GITIGNORED and releases are cut in a detached
# worktree, which by definition has none of those files, so "use the local copy or warn" meant every
# real release shipped without the model and only a log line said so.
if [[ ! -f "$MODEL_SRC" ]]; then
    if [[ "${OPENSWARM_SKIP_WHISPER_MODEL:-}" == "1" ]]; then
        echo "[whisper] OPENSWARM_SKIP_WHISPER_MODEL=1; building WITHOUT a bundled model on purpose"
        exit 0
    fi
    echo "[whisper] no local model; downloading $MODEL_FILE (~190MB)"
    mkdir -p "$(dirname "$MODEL_SRC")"
    if ! curl -fsSL --retry 3 --retry-delay 2 -o "$MODEL_SRC.part" "$MODEL_URL"; then
        rm -f "$MODEL_SRC.part"
        echo "[whisper] ERROR: could not download $MODEL_URL"
        echo "[whisper] Set OPENSWARM_SKIP_WHISPER_MODEL=1 to build without it on purpose."
        exit 1
    fi
    mv "$MODEL_SRC.part" "$MODEL_SRC"
fi

# Verify BEFORE copying: a truncated model ships silently and dies at the first press.
GOT="$(shasum -a 256 "$MODEL_SRC" | cut -d' ' -f1)"
if [[ "$GOT" != "$MODEL_SHA" ]]; then
    echo "[whisper] ERROR: $MODEL_FILE checksum mismatch (got $GOT); refusing to bundle a corrupt model"
    exit 1
fi
cp "$MODEL_SRC" "$OUT/$MODEL_FILE"
echo "[whisper] bundled model -> $OUT/$MODEL_FILE ($(du -h "$OUT/$MODEL_FILE" | cut -f1))"
