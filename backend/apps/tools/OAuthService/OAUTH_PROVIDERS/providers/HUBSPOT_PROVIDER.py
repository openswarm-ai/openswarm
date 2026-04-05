from backend.apps.tools.OAuthService.OAUTH_PROVIDERS.OAuthProvider import OAuthProvider
import os

# TODO: wtf is this, bruh we gotta remove this shit asap r u fr rn. Unacceptable.
os.environ.setdefault("HUBSPOT_CLIENT_ID", "6f4a1d4c-6a2f-4336-9b65-2cd84e218ff6")
os.environ.setdefault("HUBSPOT_CLIENT_SECRET", "5747b5de-0800-4c35-a2da-e0655ee7ea37")

HUBSPOT_PROVIDER: OAuthProvider = OAuthProvider(
    auth_url="https://mcp-na2.hubspot.com/oauth/authorize/user",
    token_url="https://api.hubapi.com/oauth/v1/token",
    scopes=[],
    userinfo_url=None,
    userinfo_field="user",
    client_id_env="HUBSPOT_CLIENT_ID",
    client_secret_env="HUBSPOT_CLIENT_SECRET",
    token_env_mapping={
        "access_token": "PRIVATE_APP_ACCESS_TOKEN",
        "refresh_token": "HUBSPOT_REFRESH_TOKEN",
    },
    token_auth_method="form",
    pkce_required=True,
)