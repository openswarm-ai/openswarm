import json
import logging
import os
import time
from typing import Optional

import httpx

from backend.config.paths import TOOLS_DIR as DATA_DIR
from backend.apps.tools_lib.models import ToolDefinition
from backend.apps.tools_lib.oauth_config import OPENSWARM_OAUTH_BASE_URL

logger = logging.getLogger(__name__)


def _save(tool: ToolDefinition) -> None:
    with open(os.path.join(DATA_DIR, f"{tool.id}.json"), "w") as f:
        json.dump(tool.model_dump(), f, indent=2)


# Tool name → provider key for the OAuth helper service. All providers go
# through the Fly cloud-proxy so client_secret values never ship inside the
# desktop binary. v1.0.28 was the last release that used a local Google
# callback with the client_secret in backend/.env.
_TOOL_NAME_TO_PROVIDER = {
    "airtable": "airtable",
    "hubspot": "hubspot",
    "discord": "discord",
    "notion": "notion",
    # Built-in Google tool's name is "Google Workspace"; accept the bare
    # "google" alias too for forward compatibility.
    "google workspace": "google",
    "google": "google",
}


def _proxied_provider_for(tool: ToolDefinition) -> Optional[str]:
    return _TOOL_NAME_TO_PROVIDER.get(tool.name.lower())


def _persist_cloud_tokens(tool: ToolDefinition, tokens: dict) -> None:
    """Normalise the cloud's claim response into tool.oauth_tokens.

    Per-provider shaping mirrors what the v1.0.25 local-callback flow used
    to write; the rest of the app (refresh helpers, MCP env injection)
    expects exactly this shape.
    """
    name = tool.name.lower()
    if name == "discord":
        new_guilds = (tokens.get("_guilds") or []) if isinstance(tokens, dict) else []
        existing = tool.oauth_tokens.get("guilds") or []
        for g in new_guilds:
            if g.get("id") and not any(e.get("id") == g["id"] for e in existing):
                existing.append({"id": g["id"], "name": g.get("name", "")})
        tool.oauth_tokens = {"guilds": existing}
        names = ", ".join(g.get("name", "") for g in existing if g.get("name"))
        tool.connected_account_email = (
            f"{len(existing)} server{'s' if len(existing) != 1 else ''}"
            + (f" · {names}" if names else "")
        )
    elif name == "notion":
        tool.oauth_tokens = {"access_token": tokens.get("access_token", "")}
        tool.connected_account_email = tokens.get("workspace_name", "Notion workspace")
    else:
        tool.oauth_tokens = {
            "access_token": tokens.get("access_token", ""),
            "refresh_token": tokens.get("refresh_token", ""),
            "token_expiry": time.time() + (tokens.get("expires_in") or 3600),
        }
        tool.connected_account_email = (
            tokens.get("email")            # Google (post-userinfo enrichment)
            or tokens.get("hub_domain")    # HubSpot
            or tokens.get("workspace_name")
            or f"{tool.name} account"
        )
    tool.auth_type = "oauth2"
    tool.auth_status = "connected"


async def _refresh_via_proxy(provider: str, tool: ToolDefinition, default_expiry: int) -> Optional[str]:
    """Refresh an OAuth access_token by POSTing the refresh_token to the
    helper service. Per-provider wrappers below pass a default expires_in
    fallback for providers that don't return one.
    """
    if tool.auth_type != "oauth2":
        return None
    refresh_token = tool.oauth_tokens.get("refresh_token")
    if not refresh_token:
        return None
    expiry = tool.oauth_tokens.get("token_expiry", 0)
    if time.time() < expiry - 60:
        return tool.oauth_tokens.get("access_token")

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(
                f"{OPENSWARM_OAUTH_BASE_URL}/api/oauth/{provider}/refresh",
                json={"refresh_token": refresh_token},
            )
        if resp.status_code == 401:
            # Provider rejected; user revoked at the provider's side. Mark
            # as needing re-auth so the UI prompts a Reconnect.
            tool.auth_status = "expired"
            _save(tool)
            logger.warning(f"{provider} refresh rejected (user revoked); marking tool as expired")
            return None
        if resp.status_code != 200:
            logger.warning(f"{provider} cloud refresh failed: HTTP %d %s", resp.status_code, resp.text[:200])
            return None

        data = (resp.json() or {}).get("tokens") or {}
        new_token = data.get("access_token", "")
        if not new_token:
            return None
        tool.oauth_tokens["access_token"] = new_token
        tool.oauth_tokens["token_expiry"] = time.time() + (data.get("expires_in") or default_expiry)
        if data.get("refresh_token"):
            # Some providers (HubSpot, Airtable) rotate refresh_tokens on every
            # refresh. Persist the new one or future refreshes will fail.
            tool.oauth_tokens["refresh_token"] = data["refresh_token"]
        # Backfill identity label on first successful refresh after upgrade.
        if not tool.connected_account_email and data.get("email"):
            tool.connected_account_email = data["email"]
        _save(tool)
        return new_token
    except Exception as e:
        logger.warning(f"{provider} cloud refresh exception for tool {tool.id}: {e}")
        return None


async def refresh_google_token(tool: ToolDefinition) -> Optional[str]:
    """Refresh an expired Google access_token via the Fly cloud-proxy.

    The client_secret never leaves Fly; desktop only POSTs the
    refresh_token. Same pattern as Airtable/HubSpot. Pre-v1.0.29 builds
    held the secret in their bundled .env; v1.0.29 removed it.
    """
    return await _refresh_via_proxy("google", tool, default_expiry=3600)


async def refresh_airtable_token(tool: ToolDefinition) -> Optional[str]:
    """Refresh an expired Airtable OAuth access_token."""
    return await _refresh_via_proxy("airtable", tool, default_expiry=7200)


async def refresh_hubspot_token(tool: ToolDefinition) -> Optional[str]:
    """Refresh an expired HubSpot OAuth access_token."""
    return await _refresh_via_proxy("hubspot", tool, default_expiry=1800)


def _m365_server_script() -> str:
    """Return the on-disk path to the bundled MS365 MCP server entry.

    v1.0.26 replaced the heavy backend/npm-servers/softeria-ms-365-mcp-server/
    node_modules tree (~93MB / 11k files) with a single esbuild bundle at
    backend/mcp-bundles/softeria-ms-365-mcp-server/dist/index.js (4.7MB).
    The new path mirrors the SDK's internal layout (dist/index.js + sibling
    package.json) because cli.js reads __dirname/../package.json for the
    --version flag; see scripts/build-app.sh `build_mcp_bundle_dir`.
    """
    _backend = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    bundle = os.path.join(
        _backend, "mcp-bundles", "softeria-ms-365-mcp-server", "dist", "index.js",
    )
    if os.path.isfile(bundle):
        return bundle
    # Fallback for any user still on a v1.0.25 install whose backend/ folder
    # was left over from before the bundle migration. Will return the legacy
    # path; if that doesn't exist either, the caller raises a clear error.
    return os.path.join(
        _backend, "npm-servers", "softeria-ms-365-mcp-server",
        "node_modules", "@softeria", "ms-365-mcp-server", "dist", "index.js",
    )


def _m365_cache_env() -> dict[str, str]:
    cache_dir = os.path.join(os.path.expanduser("~"), ".openswarm")
    os.makedirs(cache_dir, exist_ok=True)
    return {
        "MS365_MCP_TOKEN_CACHE_PATH": os.path.join(cache_dir, "ms365-token-cache.json"),
        "MS365_MCP_SELECTED_ACCOUNT_PATH": os.path.join(cache_dir, "ms365-selected-account.json"),
    }
