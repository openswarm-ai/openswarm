"""Install the browser runtime required by the LinkedIn MCP without logging in."""

from __future__ import annotations

import argparse
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description="Warm LinkedIn MCP browser runtime for OpenSwarm.")
    parser.add_argument("--user-data-dir", required=True, help="Persistent LinkedIn browser profile directory.")
    args = parser.parse_args()

    # Optional runtime dependency: this script is launched via
    # `uv run --with linkedin-scraper-mcp`, not from the backend venv.
    from linkedin_mcp_server.bootstrap import ensure_browser_installed

    Path(args.user_data_dir).expanduser().mkdir(parents=True, exist_ok=True)
    ensure_browser_installed()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
