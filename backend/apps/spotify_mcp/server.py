"""Spotify MCP server (vendored into OpenSwarm).

Spotify Web API via the `spotipy` Python client. OAuth happens in the
backend's /credentials/spotify/* endpoints BEFORE this server starts; we
just need a refresh_token (per-user, in env) plus the app-level client_id
and client_secret (OpenSwarm-team owned, also in env).

Tools cover the common asks users make in chat:
  Playback:  play, pause, skip_next, skip_previous, queue_add,
             get_currently_playing, get_playback_state
  Library:   search, get_my_playlists, get_top_tracks, get_top_artists,
             get_recently_played
  Mutate:    create_playlist, add_to_playlist

Playback actions require Spotify Premium (Spotify's API rule, not ours).
Search and library reads work on Free.
"""
from __future__ import annotations

import logging
import os
import sys
from typing import Any, Dict, List, Optional

from mcp.server.fastmcp import FastMCP
import spotipy
from spotipy.oauth2 import SpotifyOAuth, SpotifyOauthError

logger = logging.getLogger(__name__)
logger.setLevel(logging.DEBUG)

INSTRUCTIONS = """
Spotify via the Web API. 14 tools across search, playback, queue, library
reads, and playlist mutation. Playback actions require Spotify Premium.
Per-tool rate limiting is enforced by OpenSwarm.
"""

mcp = FastMCP(name="Spotify", instructions=INSTRUCTIONS)

# Lazy-init singleton client. spotipy threads connection state internally,
# so we share one across tool calls.
_client: Optional[spotipy.Spotify] = None


def _scopes() -> str:
    """Space-separated Spotify scopes the agent operates under."""
    return " ".join([
        "user-read-currently-playing",
        "user-read-playback-state",
        "user-modify-playback-state",
        "user-read-recently-played",
        "user-top-read",
        "playlist-read-private",
        "playlist-read-collaborative",
        "playlist-modify-public",
        "playlist-modify-private",
        "user-library-read",
        "user-library-modify",
    ])


def _get_client() -> spotipy.Spotify:
    """Build the singleton spotipy client from env. Refresh-token flow keeps
    a valid access_token cached internally; tokens auto-rotate on expiry."""
    global _client
    if _client is not None:
        return _client

    client_id = os.environ.get("OPENSWARM_SPOTIFY_CLIENT_ID", "").strip()
    client_secret = os.environ.get("OPENSWARM_SPOTIFY_CLIENT_SECRET", "").strip()
    refresh_token = os.environ.get("SPOTIFY_REFRESH_TOKEN", "").strip()
    redirect_uri = os.environ.get(
        "OPENSWARM_SPOTIFY_REDIRECT_URI",
        "http://127.0.0.1:8888/spotify/callback",
    )
    if not client_id or not client_secret:
        raise RuntimeError(
            "Spotify MCP missing app credentials. Set "
            "OPENSWARM_SPOTIFY_CLIENT_ID and OPENSWARM_SPOTIFY_CLIENT_SECRET "
            "in backend/.env (register an app at developer.spotify.com/dashboard)."
        )
    if not refresh_token:
        raise RuntimeError(
            "Spotify MCP missing per-user refresh token. Connect Spotify "
            "via the OpenSwarm Tools page first."
        )

    auth = SpotifyOAuth(
        client_id=client_id,
        client_secret=client_secret,
        redirect_uri=redirect_uri,
        scope=_scopes(),
        # No cache — we own token lifecycle via env. spotipy will use the
        # refresh_token to mint access tokens on demand.
        cache_handler=spotipy.cache_handler.MemoryCacheHandler(),
        open_browser=False,
    )
    # Force a token refresh now so we fail fast if the refresh_token is stale.
    try:
        token_info = auth.refresh_access_token(refresh_token)
    except SpotifyOauthError as exc:
        raise RuntimeError(f"Spotify refresh_token rejected: {exc}. Reconnect Spotify in OpenSwarm.")

    _client = spotipy.Spotify(auth=token_info["access_token"])
    return _client


def _err(exc: Exception) -> Dict[str, Any]:
    msg = str(exc) or type(exc).__name__
    return {"success": False, "message": msg[:500]}


def _track_summary(t: Dict[str, Any]) -> Dict[str, Any]:
    """Compact track dict suitable for an LLM context budget."""
    if not t:
        return {}
    artists = ", ".join(a.get("name", "") for a in (t.get("artists") or []) if a.get("name"))
    return {
        "id": t.get("id"),
        "name": t.get("name"),
        "artists": artists,
        "album": (t.get("album") or {}).get("name"),
        "duration_ms": t.get("duration_ms"),
        "uri": t.get("uri"),
        "explicit": t.get("explicit"),
    }


# ---- search / read --------------------------------------------------------


@mcp.tool()
def search(query: str, kind: str = "track", limit: int = 10) -> Dict[str, Any]:
    """Search Spotify.

    Args:
        query: Free-text query. Spotify search syntax (`artist:`, `album:`) supported.
        kind: One of 'track', 'album', 'artist', 'playlist'. Default 'track'.
        limit: Max results (1-50).
    """
    try:
        client = _get_client()
        kind = kind.lower()
        if kind not in ("track", "album", "artist", "playlist"):
            return {"success": False, "message": f"kind must be track/album/artist/playlist, got {kind!r}"}
        res = client.search(q=query, type=kind, limit=max(1, min(int(limit), 50)))
        items_key = f"{kind}s"
        items = (res.get(items_key) or {}).get("items") or []
        if kind == "track":
            results = [_track_summary(t) for t in items]
        else:
            results = [{"id": i.get("id"), "name": i.get("name"), "uri": i.get("uri")} for i in items]
        return {"success": True, "results": results}
    except Exception as e:  # noqa: BLE001
        return _err(e)


@mcp.tool()
def get_currently_playing() -> Dict[str, Any]:
    """Return what the user is listening to right now (or null if nothing)."""
    try:
        client = _get_client()
        cur = client.current_user_playing_track()
        if not cur or not cur.get("item"):
            return {"success": True, "playing": False}
        return {
            "success": True,
            "playing": cur.get("is_playing"),
            "progress_ms": cur.get("progress_ms"),
            "track": _track_summary(cur.get("item") or {}),
        }
    except Exception as e:  # noqa: BLE001
        return _err(e)


@mcp.tool()
def get_playback_state() -> Dict[str, Any]:
    """Return device + shuffle + repeat + volume state."""
    try:
        client = _get_client()
        s = client.current_playback() or {}
        device = s.get("device") or {}
        return {
            "success": True,
            "is_playing": s.get("is_playing"),
            "device_name": device.get("name"),
            "device_type": device.get("type"),
            "volume_percent": device.get("volume_percent"),
            "shuffle": s.get("shuffle_state"),
            "repeat": s.get("repeat_state"),
            "track": _track_summary((s.get("item") or {})) if s.get("item") else None,
        }
    except Exception as e:  # noqa: BLE001
        return _err(e)


@mcp.tool()
def get_recently_played(limit: int = 20) -> Dict[str, Any]:
    """Last tracks the user listened to (default 20, max 50)."""
    try:
        client = _get_client()
        res = client.current_user_recently_played(limit=max(1, min(int(limit), 50)))
        items = res.get("items") or []
        return {"success": True, "tracks": [_track_summary(i.get("track") or {}) for i in items]}
    except Exception as e:  # noqa: BLE001
        return _err(e)


@mcp.tool()
def get_top_tracks(limit: int = 10, time_range: str = "medium_term") -> Dict[str, Any]:
    """User's top tracks.

    Args:
        limit: 1-50.
        time_range: 'short_term' (~4 weeks), 'medium_term' (~6 months), 'long_term' (years).
    """
    try:
        client = _get_client()
        if time_range not in ("short_term", "medium_term", "long_term"):
            time_range = "medium_term"
        res = client.current_user_top_tracks(limit=max(1, min(int(limit), 50)), time_range=time_range)
        return {"success": True, "tracks": [_track_summary(t) for t in (res.get("items") or [])]}
    except Exception as e:  # noqa: BLE001
        return _err(e)


@mcp.tool()
def get_top_artists(limit: int = 10, time_range: str = "medium_term") -> Dict[str, Any]:
    """User's top artists. Same time_range options as get_top_tracks."""
    try:
        client = _get_client()
        if time_range not in ("short_term", "medium_term", "long_term"):
            time_range = "medium_term"
        res = client.current_user_top_artists(limit=max(1, min(int(limit), 50)), time_range=time_range)
        artists = [{"id": a.get("id"), "name": a.get("name"), "genres": a.get("genres"), "popularity": a.get("popularity")} for a in (res.get("items") or [])]
        return {"success": True, "artists": artists}
    except Exception as e:  # noqa: BLE001
        return _err(e)


@mcp.tool()
def get_my_playlists(limit: int = 20) -> Dict[str, Any]:
    """List the user's playlists (owned + followed)."""
    try:
        client = _get_client()
        res = client.current_user_playlists(limit=max(1, min(int(limit), 50)))
        playlists = [{
            "id": p.get("id"),
            "name": p.get("name"),
            "owner": (p.get("owner") or {}).get("display_name"),
            "tracks_total": (p.get("tracks") or {}).get("total"),
            "public": p.get("public"),
            "collaborative": p.get("collaborative"),
        } for p in (res.get("items") or [])]
        return {"success": True, "playlists": playlists}
    except Exception as e:  # noqa: BLE001
        return _err(e)


# ---- playback (Premium-only) ---------------------------------------------


@mcp.tool()
def play(track_uri: Optional[str] = None, context_uri: Optional[str] = None) -> Dict[str, Any]:
    """Start or resume playback. Requires Spotify Premium.

    Args:
        track_uri: Spotify track URI (e.g. 'spotify:track:...') to play immediately.
        context_uri: Album/artist/playlist URI to play from (e.g. 'spotify:playlist:...').
            If neither is set, resumes whatever was paused.
    """
    try:
        client = _get_client()
        kwargs: Dict[str, Any] = {}
        if track_uri:
            kwargs["uris"] = [track_uri]
        if context_uri:
            kwargs["context_uri"] = context_uri
        client.start_playback(**kwargs)
        return {"success": True}
    except Exception as e:  # noqa: BLE001
        return _err(e)


@mcp.tool()
def pause() -> Dict[str, Any]:
    """Pause playback. Requires Premium."""
    try:
        _get_client().pause_playback()
        return {"success": True}
    except Exception as e:  # noqa: BLE001
        return _err(e)


@mcp.tool()
def skip_next() -> Dict[str, Any]:
    """Skip to next track. Requires Premium."""
    try:
        _get_client().next_track()
        return {"success": True}
    except Exception as e:  # noqa: BLE001
        return _err(e)


@mcp.tool()
def skip_previous() -> Dict[str, Any]:
    """Skip to previous track. Requires Premium."""
    try:
        _get_client().previous_track()
        return {"success": True}
    except Exception as e:  # noqa: BLE001
        return _err(e)


@mcp.tool()
def queue_add(track_uri: str) -> Dict[str, Any]:
    """Add a track to the playback queue. Requires Premium.

    Args:
        track_uri: e.g. 'spotify:track:6rqhFgbbKwnb9MLmUQDhG6'.
    """
    try:
        _get_client().add_to_queue(uri=track_uri)
        return {"success": True}
    except Exception as e:  # noqa: BLE001
        return _err(e)


# ---- mutate library ------------------------------------------------------


@mcp.tool()
def create_playlist(name: str, description: str = "", public: bool = False) -> Dict[str, Any]:
    """Create a new playlist for the user."""
    try:
        client = _get_client()
        me = client.me()
        pl = client.user_playlist_create(user=me["id"], name=name, public=public, description=description)
        return {"success": True, "playlist_id": pl.get("id"), "name": pl.get("name"), "uri": pl.get("uri")}
    except Exception as e:  # noqa: BLE001
        return _err(e)


@mcp.tool()
def add_to_playlist(playlist_id: str, track_uris: List[str]) -> Dict[str, Any]:
    """Append tracks to a playlist.

    Args:
        playlist_id: Spotify playlist ID (the 22-char base62 string).
        track_uris: List of Spotify track URIs.
    """
    try:
        if not track_uris:
            return {"success": False, "message": "track_uris is empty"}
        _get_client().playlist_add_items(playlist_id, track_uris[:100])  # API cap is 100/call
        return {"success": True, "added": len(track_uris[:100])}
    except Exception as e:  # noqa: BLE001
        return _err(e)


# ---- main ----------------------------------------------------------------


def main() -> None:
    """Spawn entrypoint. Validate creds + refresh_token then start stdio loop."""
    try:
        _get_client()
    except RuntimeError as e:
        logger.error(str(e))
        sys.exit(1)
    logger.info("Spotify MCP ready")
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
