# pyright: reportMissingImports=false

from __future__ import annotations

import argparse
import asyncio
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description="Create a LinkedIn MCP browser profile for OpenSwarm.")
    parser.add_argument("--user-data-dir", required=True, help="Persistent LinkedIn browser profile directory.")
    args = parser.parse_args()
    
    # Supplied at subprocess runtime by `uv run --with linkedin-scraper-mcp`.
    from linkedin_mcp_server.bootstrap import ensure_browser_installed
    from linkedin_mcp_server.setup import interactive_login

    profile_dir = Path(args.user_data_dir).expanduser()
    ensure_browser_installed()
    success = asyncio.run(interactive_login(profile_dir, warm_up=False))
    return 0 if success else 1


if __name__ == "__main__":
    raise SystemExit(main())
