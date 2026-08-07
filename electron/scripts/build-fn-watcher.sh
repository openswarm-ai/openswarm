#!/bin/bash
# Compile the macOS fn/Globe key watcher for one arch and stage it where electron-builder's
# extraResources picks it up (build-staging/fn-watcher/<arch>). See electron/native/fn-watcher.swift
# for why this exists (libuiohook cannot see keycode 63, so dictation's fn trigger needs a native tap).
set -euo pipefail

ARCH="${1:?usage: build-fn-watcher.sh <arm64|x64>}"

HERE="$(cd "$(dirname "$0")/.." && pwd)"   # electron/
SRC="$HERE/native/fn-watcher.swift"
OUT="$HERE/build-staging/fn-watcher/$ARCH"
TARGET="arm64-apple-macos11"
[[ "$ARCH" == "x64" ]] && TARGET="x86_64-apple-macos11"

echo "[fn-watcher] building for arch=$ARCH (target $TARGET)"
mkdir -p "$OUT"
swiftc -O -target "$TARGET" -o "$OUT/fn-watcher" "$SRC"
echo "[fn-watcher] staged -> $OUT/fn-watcher"
file "$OUT/fn-watcher"
