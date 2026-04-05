from backend.apps.tools.OAuthService.OAUTH_PROVIDERS.OAuthProvider import OAuthProvider
from backend.apps.tools.OAuthService.OAUTH_PROVIDERS.providers.GOOGLE_PROVIDER import GOOGLE_PROVIDER
from backend.apps.tools.OAuthService.OAUTH_PROVIDERS.providers.GITHUB_PROVIDER import GITHUB_PROVIDER
from backend.apps.tools.OAuthService.OAUTH_PROVIDERS.providers.SLACK_PROVIDER import SLACK_PROVIDER
from backend.apps.tools.OAuthService.OAUTH_PROVIDERS.providers.NOTION_PROVIDER import NOTION_PROVIDER
from backend.apps.tools.OAuthService.OAUTH_PROVIDERS.providers.SPOTIFY_PROVIDER import SPOTIFY_PROVIDER
from backend.apps.tools.OAuthService.OAUTH_PROVIDERS.providers.FIGMA_PROVIDER import FIGMA_PROVIDER
from backend.apps.tools.OAuthService.OAUTH_PROVIDERS.providers.AIRTABLE_PROVIDER import AIRTABLE_PROVIDER
from backend.apps.tools.OAuthService.OAUTH_PROVIDERS.providers.HUBSPOT_PROVIDER import HUBSPOT_PROVIDER


OAUTH_PROVIDERS: dict[str, OAuthProvider] = {
    "google": GOOGLE_PROVIDER,
    "github": GITHUB_PROVIDER,
    "slack": SLACK_PROVIDER,
    "notion": NOTION_PROVIDER,
    "spotify": SPOTIFY_PROVIDER,
    "figma": FIGMA_PROVIDER,
    "airtable": AIRTABLE_PROVIDER,
    "hubspot": HUBSPOT_PROVIDER,
}
