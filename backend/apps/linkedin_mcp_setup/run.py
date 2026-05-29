"""Fast LinkedIn MCP browser-profile setup.

The upstream `linkedin-scraper-mcp --login` flow intentionally warms up the
browser by visiting non-LinkedIn sites first. That is useful for stealth, but
it makes OpenSwarm's connect UX feel confusing. This runner keeps the upstream
profile/cookie format and browser install logic, while skipping warmup so the
window opens directly to LinkedIn.
"""

from __future__ import annotations

import argparse
import asyncio
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description="Create a LinkedIn MCP browser profile for OpenSwarm.")
    parser.add_argument("--user-data-dir", required=True, help="Persistent LinkedIn browser profile directory.")
    args = parser.parse_args()

    # Optional runtime dependency: this script is launched via
    # `uv run --with linkedin-scraper-mcp`, not from the backend venv.
    from linkedin_mcp_server.bootstrap import ensure_browser_installed
    from linkedin_mcp_server.setup import interactive_login

    profile_dir = Path(args.user_data_dir).expanduser()
    ensure_browser_installed()
    success = asyncio.run(interactive_login(profile_dir, warm_up=False))
    return 0 if success else 1


if __name__ == "__main__":
    raise SystemExit(main())


