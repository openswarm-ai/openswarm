from backend.apps.tools.oauth.OAUTH_PROVIDERS.OAuthProvider import OAuthProvider
import os

# TODO: wtf is this, bruh we gotta remove this shit asap r u fr rn. Unacceptable.
os.environ.setdefault("AIRTABLE_CLIENT_ID", "0699038b-a3a4-46b2-8fa6-690eb76fadfa")
os.environ.setdefault("AIRTABLE_CLIENT_SECRET", "187fa83c8bab8ebcd11b8f226d75e7a1f14a8174ac0494463c1a53e66a3036d0")

AIRTABLE_PROVIDER: OAuthProvider = OAuthProvider(
    auth_url="https://airtable.com/oauth2/v1/authorize",
    token_url="https://airtable.com/oauth2/v1/token",
    scopes=[
        "data.records:read", "data.records:write",
        "data.recordComments:read", "data.recordComments:write",
        "schema.bases:read", "schema.bases:write",
        "user.email:read", "webhook:manage",
    ],
    userinfo_url="https://api.airtable.com/v0/meta/whoami",
    userinfo_field="email",
    client_id_env="AIRTABLE_CLIENT_ID",
    client_secret_env="AIRTABLE_CLIENT_SECRET",
    token_env_mapping={"access_token": "AIRTABLE_API_KEY"},
    pkce_required=True,
    token_auth_method="basic",
)