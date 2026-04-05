from backend.apps.tools.oauth.OAUTH_PROVIDERS.OAuthProvider import OAuthProvider
import os

# TODO: wtf is this, bruh we gotta remove this shit asap r u fr rn. Unacceptable.
os.environ.setdefault("SLACK_CLIENT_ID", "10795695056323.10799999254534")
os.environ.setdefault("SLACK_CLIENT_SECRET", "d3a85a286bb0205157d7e4963502a91d")

SLACK_PROVIDER: OAuthProvider = OAuthProvider(
    auth_url="https://slack.com/oauth/v2/authorize",
    token_url="https://slack.com/api/oauth.v2.access",
    scopes=[
        "channels:read", "channels:history", "chat:write",
        "groups:read", "groups:history", "im:read", "im:history",
        "mpim:read", "mpim:history", "users:read", "users:read.email",
        "team:read", "reactions:read", "reactions:write",
        "files:read", "files:write",
    ],
    userinfo_url="https://slack.com/api/auth.test",
    userinfo_field="user",
    client_id_env="SLACK_CLIENT_ID",
    client_secret_env="SLACK_CLIENT_SECRET",
    token_env_mapping={"access_token": "SLACK_BOT_TOKEN"},
    extra_token_fields={"team.id": "SLACK_TEAM_ID"},
    token_auth_method="form",
    pkce_required=False,
)