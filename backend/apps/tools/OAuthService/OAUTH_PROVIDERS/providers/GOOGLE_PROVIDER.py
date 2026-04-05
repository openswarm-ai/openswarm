from backend.apps.tools.OAuthService.OAUTH_PROVIDERS.OAuthProvider import OAuthProvider
import os

# TODO: wtf is this, bruh we gotta remove this shit asap r u fr rn. Unacceptable.
os.environ.setdefault("GOOGLE_OAUTH_CLIENT_ID", "6741219524-8vpt07arcc5rvkdb4j1b6v9g53469ugq.apps.googleusercontent.com")
os.environ.setdefault("GOOGLE_OAUTH_CLIENT_SECRET", "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")

GOOGLE_PROVIDER: OAuthProvider = OAuthProvider(
    auth_url="https://accounts.google.com/o/oauth2/v2/auth",
    token_url="https://oauth2.googleapis.com/token",
    scopes=[
        "openid",
        "https://www.googleapis.com/auth/userinfo.email",
        "https://www.googleapis.com/auth/gmail.modify",
        "https://www.googleapis.com/auth/calendar",
        "https://www.googleapis.com/auth/drive",
        "https://www.googleapis.com/auth/contacts.readonly",
    ],
    userinfo_url="https://www.googleapis.com/oauth2/v2/userinfo",
    userinfo_field="email",
    client_id_env="GOOGLE_OAUTH_CLIENT_ID",
    client_secret_env="GOOGLE_OAUTH_CLIENT_SECRET",
    token_env_mapping={
        "access_token": "OAUTH_ACCESS_TOKEN",
        "refresh_token": "GOOGLE_WORKSPACE_REFRESH_TOKEN",
        "_client_id": "GOOGLE_WORKSPACE_CLIENT_ID",
        "_client_secret": "GOOGLE_WORKSPACE_CLIENT_SECRET",
    },
    extra_auth_params={"access_type": "offline", "prompt": "consent"},
    pkce_required=False,
    token_auth_method="form",
)