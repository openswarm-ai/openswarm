#!/bin/bash
# Publishes release-shell/ as the only content of the public shell's main. Tags and releases are never touched:
# every installed updater and every download link reads them from this repo, and a deleted tag takes its release off the feed.
set -euo pipefail

SHELL_REPO="${RELEASE_SHELL_REPO:-openswarm-ai/openswarm}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MODE="${1:---dry-run}"
case "$MODE" in
    --dry-run|--apply|--apply-and-prune) ;;
    *) echo "usage: sync-shell.sh [--dry-run|--apply|--apply-and-prune]" >&2; exit 2 ;;
esac

cmp -s "$ROOT/scripts/release/verify-release.js" "$ROOT/release-shell/scripts/release/verify-release.js" \
    || { echo "release-shell/scripts/release/verify-release.js drifted from scripts/release/verify-release.js" >&2; exit 1; }
cmp -s "$ROOT/electron/build/icon.ico" "$ROOT/release-shell/electron/build/icon.ico" \
    || { echo "release-shell/electron/build/icon.ico drifted from electron/build/icon.ico" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
git init -q "$WORK"
cp -R "$ROOT/release-shell/." "$WORK/"
(cd "$WORK" && git add -A && git -c user.name=openswarm -c user.email=releases@openswarm.com commit -q -m "releases shell, synced $(date -u +%Y-%m-%d)")

echo "== $SHELL_REPO main would carry:"
(cd "$WORK" && git ls-files | sed 's/^/   /')
others="$(gh api "repos/$SHELL_REPO/branches?per_page=100" --paginate --jq '.[].name' | grep -vx main || true)"
echo "== branches on $SHELL_REPO other than main: $(printf '%s\n' "$others" | grep -c . || true)"
echo "== tags on $SHELL_REPO (kept): $(gh api "repos/$SHELL_REPO/tags?per_page=100" --paginate --jq '.[].name' | grep -c . || true)"

if [ "$MODE" = "--dry-run" ]; then
    echo "dry run: nothing pushed, nothing deleted"
    exit 0
fi

(cd "$WORK" && git push --force "https://github.com/$SHELL_REPO.git" HEAD:refs/heads/main)
echo "pushed release-shell/ as $SHELL_REPO main"

if [ "$MODE" = "--apply-and-prune" ]; then
    for b in $others; do
        gh api -X DELETE "repos/$SHELL_REPO/git/refs/heads/$b" >/dev/null && echo "deleted branch $b"
    done
fi
