#!/usr/bin/env bash
# One-time interactive setup for the LinkedIn MCP server
# (stickerdaniel/linkedin-mcp-server, PyPI: linkedin-scraper-mcp).
#
# Why this needs a script: auth is a persistent Patchright browser profile.
# The --login flag opens a real Chromium window so you (the human) can sign in,
# handle 2FA / captcha, and save state to ~/.linkedin-mcp/profile/. The MCP
# server then reuses that profile on every start, headlessly.
#
# Re-run when sessions expire. To wipe the profile, run:
#   uvx linkedin-scraper-mcp@latest --logout

set -euo pipefail

if ! command -v uvx >/dev/null 2>&1; then
  echo "error: uvx not found on PATH." >&2
  echo "Install uv first: https://docs.astral.sh/uv/getting-started/installation/" >&2
  exit 1
fi

UV_HTTP_TIMEOUT="${UV_HTTP_TIMEOUT:-300}"
export UV_HTTP_TIMEOUT

echo "Opening Chromium for LinkedIn login. Complete sign-in (and 2FA if prompted)."
echo "Profile will be saved to ~/.linkedin-mcp/profile/"
exec uvx linkedin-scraper-mcp@latest --login
