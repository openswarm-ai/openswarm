from backend.apps.tools.oauth.OAUTH_PROVIDERS.OAuthProvider import OAuthProvider

# TODO: why doesn't spotify have any client id or secret?

SPOTIFY_PROVIDER: OAuthProvider = OAuthProvider(
    auth_url="https://accounts.spotify.com/authorize",
    token_url="https://accounts.spotify.com/api/token",
    scopes=[
        "user-read-playback-state", "user-modify-playback-state",
        "user-read-currently-playing", "playlist-read-private",
        "playlist-modify-public", "playlist-modify-private",
        "user-library-read", "user-library-modify",
        "user-read-recently-played", "user-top-read",
    ],
    userinfo_url="https://api.spotify.com/v1/me",
    userinfo_field="display_name",
    client_id_env="SPOTIFY_CLIENT_ID",
    client_secret_env="SPOTIFY_CLIENT_SECRET",
    token_env_mapping={
        "access_token": "SPOTIFY_ACCESS_TOKEN",
        "refresh_token": "SPOTIFY_REFRESH_TOKEN",
        "_client_id": "SPOTIFY_CLIENT_ID",
        "_client_secret": "SPOTIFY_CLIENT_SECRET",
    },
    token_auth_method="basic",
    pkce_required=False,
)