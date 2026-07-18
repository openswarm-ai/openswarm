"""MCP tool surface for Spotify: the things a logged-in human does.

Plays tracks. This is accomplished via a Playwright session, which may require
the user to manually input their credentials or solve a CAPTCHA.
"""

OBJ = "object"

TOOLS = [
    {
        "name": "play_track",
        "description": "Opens a browser and plays the requested song.",
        "inputSchema": {
            "type": OBJ,
            "properties": {
                "track_name": {"type": "string"},
                "artist": {"type": "string"}
            },
            "required": ["track_name"]
        }
    }
]