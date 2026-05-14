"""Module entrypoint so `python -m backend.apps.twitter_mcp_shim` works."""
from backend.apps.twitter_mcp_shim.server import main

if __name__ == "__main__":
    main()
