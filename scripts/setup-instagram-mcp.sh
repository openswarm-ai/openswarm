#!/usr/bin/env bash
# One-time setup for the Instagram MCP server. Each OpenSwarm user runs this
# once on their machine; it installs the ShawnMadadha/instagram_dm_mcp fork
# (carries the per-tool rate limiter that protects accounts from anti-abuse
# bans) into ~/.openswarm/instagram-mcp/ and pip-installs its dependencies
# into a local venv. Re-running upgrades to the latest version.
#
# Why a fork: trypeggy/instagram_dm_mcp upstream does not have the rate
# limiter yet. PR is open at trypeggy/instagram_dm_mcp#12.

set -euo pipefail

DEST="$HOME/.openswarm/instagram-mcp"
REPO_URL="https://github.com/ShawnMadadha/instagram_dm_mcp.git"

if ! command -v git >/dev/null 2>&1; then
  echo "error: git not found on PATH." >&2
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "error: python3 not found on PATH." >&2
  exit 1
fi

if [ -d "$DEST/.git" ]; then
  echo "Updating existing checkout at $DEST..."
  git -C "$DEST" fetch --quiet
  git -C "$DEST" reset --hard origin/main --quiet
else
  echo "Cloning $REPO_URL into $DEST..."
  mkdir -p "$(dirname "$DEST")"
  git clone --depth=1 --quiet "$REPO_URL" "$DEST"
fi

VENV="$DEST/.venv"
if [ ! -d "$VENV" ]; then
  echo "Creating venv at $VENV..."
  python3 -m venv "$VENV"
fi

echo "Installing requirements into venv..."
"$VENV/bin/python" -m pip install --quiet --upgrade pip
"$VENV/bin/python" -m pip install --quiet -r "$DEST/requirements.txt"

echo "Installed: $DEST"
"$VENV/bin/python" -c "from pathlib import Path; print(' python:', Path('$VENV/bin/python').resolve()); print(' server:', '$DEST/src/mcp_server.py')"
echo "Done. Connect Instagram from the OpenSwarm Tools page next."
