from backend.apps.tools.oauth.OAUTH_PROVIDERS.OAuthProvider import OAuthProvider
import os

# TODO: wtf is this, bruh we gotta remove this shit asap r u fr rn. Unacceptable.
os.environ.setdefault("GITHUB_OAUTH_CLIENT_ID", "Ov23liDcwNJaKMjXY2jI")
os.environ.setdefault("GITHUB_OAUTH_CLIENT_SECRET", "b25fe39409896aad3fd5155f032e9868440002f8")

GITHUB_PROVIDER: OAuthProvider = OAuthProvider(
    auth_url="https://github.com/login/oauth/authorize",
    token_url="https://github.com/login/oauth/access_token",
    scopes=["repo", "read:user", "user:email"],
    userinfo_url="https://api.github.com/user",
    userinfo_field="login",
    client_id_env="GITHUB_OAUTH_CLIENT_ID",
    client_secret_env="GITHUB_OAUTH_CLIENT_SECRET",
    token_env_mapping={"access_token": "GITHUB_PERSONAL_ACCESS_TOKEN"},
    token_auth_method="form",
    pkce_required=False,
)