#!/bin/bash
# The shell is the public repo every installed updater polls; a build repo's own workflow token cannot write to it.
set -euo pipefail

SHELL_REPO="${RELEASE_SHELL_REPO:-openswarm-ai/openswarm}"

if [ -z "${GH_TOKEN:-}" ]; then
    echo "RELEASE_SHELL_TOKEN is not set: this run cannot publish into $SHELL_REPO" >&2
    exit 1
fi
if ! gh api "repos/$SHELL_REPO" --jq '.full_name' >/dev/null; then
    echo "the release token cannot read $SHELL_REPO" >&2
    exit 1
fi
if [ "$(gh api "repos/$SHELL_REPO" --jq '.permissions.push')" != "true" ]; then
    echo "the release token cannot write to $SHELL_REPO, so the release would land nowhere" >&2
    exit 1
fi
gh release list --repo "$SHELL_REPO" --limit 1 >/dev/null
echo "release shell $SHELL_REPO is reachable with write access"
