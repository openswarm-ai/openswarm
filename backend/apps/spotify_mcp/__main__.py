"""Module entrypoint: `python -m backend.apps.spotify_mcp`.

Spawned by OpenSwarm when an agent invokes a Spotify tool. Auth happens
before this server starts — the backend's /credentials/spotify/* endpoints
drive the OAuth flow and persist a refresh_token in the tool config; this
process just refreshes the access_token from it at startup and uses the
Spotify Web API.
"""
from backend.apps.spotify_mcp.server import main

if __name__ == "__main__":
    main()
