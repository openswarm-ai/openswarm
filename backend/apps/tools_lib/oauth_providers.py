"""OAuth provider definitions — pure data, no route handlers."""

from __future__ import annotations

import os
from dataclasses import dataclass, field

from fastapi import HTTPException

# Default OAuth credentials (public client IDs safe to embed per vendor docs).
_DEFAULT_GOOGLE_CLIENT_ID = "6741219524-8vpt07arcc5rvkdb4j1b6v9g53469ugq.apps.googleusercontent.com"
_DEFAULT_GOOGLE_CLIENT_SECRET = "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"
os.environ.setdefault("GOOGLE_OAUTH_CLIENT_ID", _DEFAULT_GOOGLE_CLIENT_ID)
os.environ.setdefault("GOOGLE_OAUTH_CLIENT_SECRET", _DEFAULT_GOOGLE_CLIENT_SECRET)
os.environ.setdefault("GITHUB_OAUTH_CLIENT_ID", "Ov23liDcwNJaKMjXY2jI")
os.environ.setdefault("GITHUB_OAUTH_CLIENT_SECRET", "b25fe39409896aad3fd5155f032e9868440002f8")
os.environ.setdefault("SLACK_CLIENT_ID", "10795695056323.10799999254534")
os.environ.setdefault("SLACK_CLIENT_SECRET", "d3a85a286bb0205157d7e4963502a91d")
os.environ.setdefault("FIGMA_CLIENT_ID", "q6WduT7UuPaO6lM88v6ddN")
os.environ.setdefault("FIGMA_CLIENT_SECRET", "dhNZdbEuyEWC15cKLwWpqTclyOSplD")
os.environ.setdefault("AIRTABLE_CLIENT_ID", "0699038b-a3a4-46b2-8fa6-690eb76fadfa")
os.environ.setdefault("AIRTABLE_CLIENT_SECRET", "187fa83c8bab8ebcd11b8f226d75e7a1f14a8174ac0494463c1a53e66a3036d0")
os.environ.setdefault("HUBSPOT_CLIENT_ID", "6f4a1d4c-6a2f-4336-9b65-2cd84e218ff6")
os.environ.setdefault("HUBSPOT_CLIENT_SECRET", "5747b5de-0800-4c35-a2da-e0655ee7ea37")

GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo"
GOOGLE_SCOPES = [
    "openid",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/contacts.readonly",
]


@dataclass
class OAuthProvider:
    auth_url: str
    token_url: str
    scopes: list[str]
    userinfo_url: str | None
    userinfo_field: str
    client_id_env: str
    client_secret_env: str
    token_env_mapping: dict[str, str]
    extra_auth_params: dict[str, str] = field(default_factory=dict)
    revoke_url: str | None = None
    token_response_path: str | None = None
    token_auth_method: str = "form"
    pkce_required: bool = False
    env_value_transform: str | None = None
    extra_token_fields: dict[str, str] = field(default_factory=dict)


OAUTH_PROVIDERS: dict[str, OAuthProvider] = {
    "google": OAuthProvider(
        auth_url=GOOGLE_AUTH_URL, token_url=GOOGLE_TOKEN_URL,
        scopes=GOOGLE_SCOPES, userinfo_url=GOOGLE_USERINFO_URL,
        userinfo_field="email", client_id_env="GOOGLE_OAUTH_CLIENT_ID",
        client_secret_env="GOOGLE_OAUTH_CLIENT_SECRET",
        token_env_mapping={
            "access_token": "OAUTH_ACCESS_TOKEN",
            "refresh_token": "GOOGLE_WORKSPACE_REFRESH_TOKEN",
            "_client_id": "GOOGLE_WORKSPACE_CLIENT_ID",
            "_client_secret": "GOOGLE_WORKSPACE_CLIENT_SECRET",
        },
        extra_auth_params={"access_type": "offline", "prompt": "consent"},
    ),
    "github": OAuthProvider(
        auth_url="https://github.com/login/oauth/authorize",
        token_url="https://github.com/login/oauth/access_token",
        scopes=["repo", "read:user", "user:email"],
        userinfo_url="https://api.github.com/user", userinfo_field="login",
        client_id_env="GITHUB_OAUTH_CLIENT_ID", client_secret_env="GITHUB_OAUTH_CLIENT_SECRET",
        token_env_mapping={"access_token": "GITHUB_PERSONAL_ACCESS_TOKEN"},
    ),
    "slack": OAuthProvider(
        auth_url="https://slack.com/oauth/v2/authorize",
        token_url="https://slack.com/api/oauth.v2.access",
        scopes=[
            "channels:read", "channels:history", "chat:write",
            "groups:read", "groups:history", "im:read", "im:history",
            "mpim:read", "mpim:history", "users:read", "users:read.email",
            "team:read", "reactions:read", "reactions:write",
            "files:read", "files:write",
        ],
        userinfo_url="https://slack.com/api/auth.test", userinfo_field="user",
        client_id_env="SLACK_CLIENT_ID", client_secret_env="SLACK_CLIENT_SECRET",
        token_env_mapping={"access_token": "SLACK_BOT_TOKEN"},
        extra_token_fields={"team.id": "SLACK_TEAM_ID"},
    ),
    "notion": OAuthProvider(
        auth_url="https://api.notion.com/v1/oauth/authorize",
        token_url="https://api.notion.com/v1/oauth/token",
        scopes=[], userinfo_url=None, userinfo_field="owner",
        client_id_env="NOTION_OAUTH_CLIENT_ID", client_secret_env="NOTION_OAUTH_CLIENT_SECRET",
        token_env_mapping={"access_token": "OPENAPI_MCP_HEADERS"},
        extra_auth_params={"owner": "user"},
        token_auth_method="basic_json", env_value_transform="notion_headers",
    ),
    "spotify": OAuthProvider(
        auth_url="https://accounts.spotify.com/authorize",
        token_url="https://accounts.spotify.com/api/token",
        scopes=[
            "user-read-playback-state", "user-modify-playback-state",
            "user-read-currently-playing", "playlist-read-private",
            "playlist-modify-public", "playlist-modify-private",
            "user-library-read", "user-library-modify",
            "user-read-recently-played", "user-top-read",
        ],
        userinfo_url="https://api.spotify.com/v1/me", userinfo_field="display_name",
        client_id_env="SPOTIFY_CLIENT_ID", client_secret_env="SPOTIFY_CLIENT_SECRET",
        token_env_mapping={
            "access_token": "SPOTIFY_ACCESS_TOKEN",
            "refresh_token": "SPOTIFY_REFRESH_TOKEN",
            "_client_id": "SPOTIFY_CLIENT_ID",
            "_client_secret": "SPOTIFY_CLIENT_SECRET",
        },
        token_auth_method="basic",
    ),
    "figma": OAuthProvider(
        auth_url="https://www.figma.com/oauth",
        token_url="https://api.figma.com/v1/oauth/token",
        scopes=["current_user:read", "file_content:read", "file_metadata:read", "file_comments:read", "file_comments:write", "file_versions:read", "file_variables:read"],
        userinfo_url="https://api.figma.com/v1/me", userinfo_field="email",
        client_id_env="FIGMA_CLIENT_ID", client_secret_env="FIGMA_CLIENT_SECRET",
        token_env_mapping={"access_token": "FIGMA_API_KEY"},
    ),
    "airtable": OAuthProvider(
        auth_url="https://airtable.com/oauth2/v1/authorize",
        token_url="https://airtable.com/oauth2/v1/token",
        scopes=[
            "data.records:read", "data.records:write",
            "data.recordComments:read", "data.recordComments:write",
            "schema.bases:read", "schema.bases:write",
            "user.email:read", "webhook:manage",
        ],
        userinfo_url="https://api.airtable.com/v0/meta/whoami", userinfo_field="email",
        client_id_env="AIRTABLE_CLIENT_ID", client_secret_env="AIRTABLE_CLIENT_SECRET",
        token_env_mapping={"access_token": "AIRTABLE_API_KEY"},
        pkce_required=True, token_auth_method="basic",
    ),
    "hubspot": OAuthProvider(
        auth_url="https://mcp-na2.hubspot.com/oauth/authorize/user",
        token_url="https://api.hubapi.com/oauth/v1/token",
        scopes=[], userinfo_url=None, userinfo_field="user",
        client_id_env="HUBSPOT_CLIENT_ID", client_secret_env="HUBSPOT_CLIENT_SECRET",
        token_env_mapping={
            "access_token": "PRIVATE_APP_ACCESS_TOKEN",
            "refresh_token": "HUBSPOT_REFRESH_TOKEN",
        },
        pkce_required=True,
    ),
}


def _resolve_oauth_provider(tool) -> OAuthProvider:
    """Resolve the OAuth provider for a tool, defaulting to Google."""
    key = tool.oauth_provider or "google"
    provider = OAUTH_PROVIDERS.get(key)
    if not provider:
        raise HTTPException(status_code=400, detail=f"Unknown OAuth provider: {key}")
    return provider
