"""Module entrypoint: `python -m backend.apps.telegram_mcp`.

Spawned by OpenSwarm when an agent invokes a Telegram tool. Auth happens
before this server starts — the backend's /credentials/telegram/* endpoints
drive the phone -> code -> (optional 2FA) flow via Telethon and persist a
session file at ~/.telegram_mcp/sessions/<phone>.session. This server
loads that session, never the password.
"""
from backend.apps.telegram_mcp.server import main

if __name__ == "__main__":
    main()
