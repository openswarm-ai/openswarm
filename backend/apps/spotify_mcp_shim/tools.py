"""MCP tool surface for Spotify: the things a logged-in human does.

Plays tracks. This is accomplished via a Playwright session, which may require
the user to manually input their credentials or solve a CAPTCHA.
"""

OBJ = "object"

TOOLS = [
    {
        "name": "play_track",
        "description": "Opens an external browser (like Chrome or Edge) to bypass DRM and plays the requested song. NOTE: The user will see a separate browser window open.",
        "inputSchema": {
            "type": OBJ,
            "properties": {
                "track_name": {"type": "string"},
                "artist": {"type": "string"}
            },
            "required": ["track_name"]
        }
    },
    {
        "name": "play_album",
        "description": "Opens an external browser (like Chrome or Edge) to bypass DRM and plays the requested album. NOTE: The user will see a separate browser window open.",
        "inputSchema": {
            "type": OBJ,
            "properties": {
                "album_name": {"type": "string"},
                "artist": {"type": "string"}
            },
            "required": ["album_name"]
        }
    },
    {
        "name": "play_playlist",
        "description": "Opens an external browser (like Chrome or Edge) to bypass DRM and plays the requested playlist. NOTE: The user will see a separate browser window open.",
        "inputSchema": {
            "type": OBJ,
            "properties": {
                "playlist_name": {"type": "string"}
            },
            "required": ["playlist_name"]
        }
    },
    {
        "name": "play_artist",
        "description": "Opens an external browser (like Chrome or Edge) to bypass DRM and plays the requested artist's top tracks. NOTE: The user will see a separate browser window open.",
        "inputSchema": {
            "type": OBJ,
            "properties": {
                "artist_name": {"type": "string"}
            },
            "required": ["artist_name"]
        }
    }
]