from backend.apps.tools.oauth.OAUTH_PROVIDERS.OAuthProvider import OAuthProvider

# TODO: why doesn't notion have any client id or secret?

NOTION_PROVIDER: OAuthProvider = OAuthProvider(
    auth_url="https://api.notion.com/v1/oauth/authorize",
    token_url="https://api.notion.com/v1/oauth/token",
    scopes=[],
    userinfo_url=None,
    userinfo_field="owner",
    client_id_env="NOTION_OAUTH_CLIENT_ID",
    client_secret_env="NOTION_OAUTH_CLIENT_SECRET",
    token_env_mapping={"access_token": "OPENAPI_MCP_HEADERS"},
    extra_auth_params={"owner": "user"},
    token_auth_method="basic_json",
    pkce_required=False,
    env_value_transform="notion_headers",
)