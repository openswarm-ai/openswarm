from backend.apps.tools.OAuthService.OAUTH_PROVIDERS.OAuthProvider import OAuthProvider
import os

# TODO: wtf is this, bruh we gotta remove this shit asap r u fr rn. Unacceptable.
os.environ.setdefault("FIGMA_CLIENT_ID", "q6WduT7UuPaO6lM88v6ddN")
os.environ.setdefault("FIGMA_CLIENT_SECRET", "dhNZdbEuyEWC15cKLwWpqTclyOSplD")

FIGMA_PROVIDER: OAuthProvider = OAuthProvider(
    auth_url="https://www.figma.com/oauth",
    token_url="https://api.figma.com/v1/oauth/token",
    scopes=[
        "current_user:read", "file_content:read", "file_metadata:read",
        "file_comments:read", "file_comments:write",
        "file_versions:read", "file_variables:read",
    ],
    userinfo_url="https://api.figma.com/v1/me",
    userinfo_field="email",
    client_id_env="FIGMA_CLIENT_ID",
    client_secret_env="FIGMA_CLIENT_SECRET",
    token_env_mapping={"access_token": "FIGMA_API_KEY"},
    token_auth_method="form",
    pkce_required=False,
)