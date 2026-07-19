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
            "type": "object",
            "properties": {
                "track_name": {"type": "string"},
                "artist": {"type": "string"},
                "engine": {"type": "string", "enum": ["chromium", "safari_applescript"]}
            },
            "required": ["track_name"]
        }
    },
    {
        "name": "play_album",
        "description": "Opens an external browser (like Chrome or Edge) to bypass DRM and plays the requested album. NOTE: The user will see a separate browser window open.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "album_name": {"type": "string"},
                "artist": {"type": "string"},
                "engine": {"type": "string", "enum": ["chromium", "safari_applescript"]}
            },
            "required": ["album_name"]
        }
    },
    {
        "name": "play_playlist",
        "description": "Opens an external browser (like Chrome or Edge) to bypass DRM and plays the requested playlist. NOTE: The user will see a separate browser window open.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "playlist_name": {"type": "string"},
                "engine": {"type": "string", "enum": ["chromium", "safari_applescript"]}
            },
            "required": ["playlist_name"]
        }
    },
    {
        "name": "play_artist",
        "description": "Opens an external browser (like Chrome or Edge) to bypass DRM and plays the requested artist's top tracks. NOTE: The user will see a separate browser window open.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "artist_name": {"type": "string"},
                "engine": {"type": "string", "enum": ["chromium", "safari_applescript"]}
            },
            "required": ["artist_name"]
        }
    },
    {
        "name": "set_default_engine",
        "description": "Sets the user's preferred browser engine for Spotify playback. Trigger this *only* if the user requests Safari or a Chromium browser, and this tool hasn't been called yet.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "engine": {"type": "string", "enum": ["chromium", "safari_applescript"]}
            },
            "required": ["engine"]
        }
    }
]