import asyncio
import base64
import hashlib
import json
import os
import re
import logging
import secrets
import shutil
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Any, Optional
from urllib.parse import urlencode

import httpx
from dotenv import load_dotenv
from fastapi import HTTPException, Query
from fastapi.responses import HTMLResponse
from backend.config.Apps import SubApp
from backend.apps.common.json_store import JsonStore
from backend.apps.tools_lib.models import ToolDefinition, ToolCreate, ToolUpdate, BUILTIN_TOOLS

logger = logging.getLogger(__name__)

# Default Google OAuth credentials for the OpenSwarm project.
# These are public credentials for a desktop/web OAuth client (safe to embed per Google's docs).
# Users can override via GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET env vars.
_DEFAULT_GOOGLE_CLIENT_ID = "6741219524-8vpt07arcc5rvkdb4j1b6v9g53469ugq.apps.googleusercontent.com"
_DEFAULT_GOOGLE_CLIENT_SECRET = "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"
os.environ.setdefault("GOOGLE_OAUTH_CLIENT_ID", _DEFAULT_GOOGLE_CLIENT_ID)
os.environ.setdefault("GOOGLE_OAUTH_CLIENT_SECRET", _DEFAULT_GOOGLE_CLIENT_SECRET)

# Default GitHub OAuth credentials for the OpenSwarm project.
os.environ.setdefault("GITHUB_OAUTH_CLIENT_ID", "Ov23liDcwNJaKMjXY2jI")
os.environ.setdefault("GITHUB_OAUTH_CLIENT_SECRET", "b25fe39409896aad3fd5155f032e9868440002f8")

# Default Slack OAuth credentials (requires HTTPS redirect — not yet functional)
os.environ.setdefault("SLACK_CLIENT_ID", "10795695056323.10799999254534")
os.environ.setdefault("SLACK_CLIENT_SECRET", "d3a85a286bb0205157d7e4963502a91d")

# Default Figma OAuth credentials for the OpenSwarm project.
os.environ.setdefault("FIGMA_CLIENT_ID", "q6WduT7UuPaO6lM88v6ddN")
os.environ.setdefault("FIGMA_CLIENT_SECRET", "dhNZdbEuyEWC15cKLwWpqTclyOSplD")

# Default Airtable OAuth credentials for the OpenSwarm project.
os.environ.setdefault("AIRTABLE_CLIENT_ID", "0699038b-a3a4-46b2-8fa6-690eb76fadfa")
os.environ.setdefault("AIRTABLE_CLIENT_SECRET", "187fa83c8bab8ebcd11b8f226d75e7a1f14a8174ac0494463c1a53e66a3036d0")

# Default HubSpot MCP Auth App credentials for the OpenSwarm project.
os.environ.setdefault("HUBSPOT_CLIENT_ID", "6f4a1d4c-6a2f-4336-9b65-2cd84e218ff6")
os.environ.setdefault("HUBSPOT_CLIENT_SECRET", "5747b5de-0800-4c35-a2da-e0655ee7ea37")

from backend.config.paths import BACKEND_DIR, DATA_ROOT, TOOLS_DIR as DATA_DIR, BUILTIN_PERMISSIONS_PATH as BUILTIN_PERMS_PATH

load_dotenv(os.path.join(BACKEND_DIR, ".env"))
if os.environ.get("OPENSWARM_PACKAGED") == "1":
    load_dotenv(os.path.join(os.path.dirname(DATA_ROOT), ".env"), override=True)


@asynccontextmanager
async def tools_lib_lifespan():
    os.makedirs(DATA_DIR, exist_ok=True)
    yield


tools_lib = SubApp("tools", tools_lib_lifespan)

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


# ---------------------------------------------------------------------------
# Multi-provider OAuth registry
# ---------------------------------------------------------------------------

@dataclass
class OAuthProvider:
    auth_url: str
    token_url: str
    scopes: list[str]
    userinfo_url: str | None
    userinfo_field: str  # JSON field for display name/email
    client_id_env: str
    client_secret_env: str
    token_env_mapping: dict[str, str]  # oauth_tokens key -> MCP env var name
    extra_auth_params: dict[str, str] = field(default_factory=dict)
    revoke_url: str | None = None
    # For providers where token response nests the access_token differently
    token_response_path: str | None = None  # e.g. "authed_user.access_token" for Slack
    # Token exchange auth method: "form" (default), "basic" (Basic Auth header), "basic_json" (Basic Auth + JSON body)
    token_auth_method: str = "form"
    # Whether PKCE is required
    pkce_required: bool = False
    # Custom transform for env var value (e.g., wrapping token in JSON for Notion)
    env_value_transform: str | None = None  # e.g., "notion_headers"
    # Extra token response fields to extract (e.g., Slack team_id)
    extra_token_fields: dict[str, str] = field(default_factory=dict)  # response_path -> env_var


OAUTH_PROVIDERS: dict[str, OAuthProvider] = {
    "google": OAuthProvider(
        auth_url=GOOGLE_AUTH_URL,
        token_url=GOOGLE_TOKEN_URL,
        scopes=GOOGLE_SCOPES,
        userinfo_url=GOOGLE_USERINFO_URL,
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
    ),
    "github": OAuthProvider(
        auth_url="https://github.com/login/oauth/authorize",
        token_url="https://github.com/login/oauth/access_token",
        scopes=["repo", "read:user", "user:email"],
        userinfo_url="https://api.github.com/user",
        userinfo_field="login",
        client_id_env="GITHUB_OAUTH_CLIENT_ID",
        client_secret_env="GITHUB_OAUTH_CLIENT_SECRET",
        token_env_mapping={
            "access_token": "GITHUB_PERSONAL_ACCESS_TOKEN",
        },
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
        userinfo_url="https://slack.com/api/auth.test",
        userinfo_field="user",
        client_id_env="SLACK_CLIENT_ID",
        client_secret_env="SLACK_CLIENT_SECRET",
        token_env_mapping={
            "access_token": "SLACK_BOT_TOKEN",
        },
        extra_token_fields={"team.id": "SLACK_TEAM_ID"},
    ),
    "notion": OAuthProvider(
        auth_url="https://api.notion.com/v1/oauth/authorize",
        token_url="https://api.notion.com/v1/oauth/token",
        scopes=[],  # Notion doesn't use scopes in the auth URL
        userinfo_url=None,
        userinfo_field="owner",
        client_id_env="NOTION_OAUTH_CLIENT_ID",
        client_secret_env="NOTION_OAUTH_CLIENT_SECRET",
        token_env_mapping={
            "access_token": "OPENAPI_MCP_HEADERS",
        },
        extra_auth_params={"owner": "user"},
        token_auth_method="basic_json",
        env_value_transform="notion_headers",
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
        userinfo_url="https://api.spotify.com/v1/me",
        userinfo_field="display_name",
        client_id_env="SPOTIFY_CLIENT_ID",
        client_secret_env="SPOTIFY_CLIENT_SECRET",
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
        userinfo_url="https://api.figma.com/v1/me",
        userinfo_field="email",
        client_id_env="FIGMA_CLIENT_ID",
        client_secret_env="FIGMA_CLIENT_SECRET",
        token_env_mapping={
            "access_token": "FIGMA_API_KEY",
        },
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
        userinfo_url="https://api.airtable.com/v0/meta/whoami",
        userinfo_field="email",
        client_id_env="AIRTABLE_CLIENT_ID",
        client_secret_env="AIRTABLE_CLIENT_SECRET",
        token_env_mapping={
            "access_token": "AIRTABLE_API_KEY",
        },
        pkce_required=True,
        token_auth_method="basic",
    ),
    "hubspot": OAuthProvider(
        auth_url="https://mcp-na2.hubspot.com/oauth/authorize/user",
        token_url="https://api.hubapi.com/oauth/v1/token",
        scopes=[],  # MCP Auth Apps have preconfigured scopes
        userinfo_url=None,  # HubSpot userinfo requires token-in-path, handle separately
        userinfo_field="user",
        client_id_env="HUBSPOT_CLIENT_ID",
        client_secret_env="HUBSPOT_CLIENT_SECRET",
        token_env_mapping={
            "access_token": "PRIVATE_APP_ACCESS_TOKEN",
            "refresh_token": "HUBSPOT_REFRESH_TOKEN",
        },
        pkce_required=True,
    ),
}


def _resolve_oauth_provider(tool: ToolDefinition) -> OAuthProvider:
    """Resolve the OAuth provider for a tool, defaulting to Google for backward compat."""
    key = tool.oauth_provider or "google"
    provider = OAUTH_PROVIDERS.get(key)
    if not provider:
        raise HTTPException(status_code=400, detail=f"Unknown OAuth provider: {key}")
    return provider


_pending_oauth: dict[str, str] = {}
_pending_pkce: dict[str, str] = {}  # state -> code_verifier (for PKCE flows)


_store = JsonStore(ToolDefinition, DATA_DIR, not_found_detail="Tool not found")

_load_all = _store.load_all
_save = _store.save
_load = _store.load


@tools_lib.router.get("/builtin")
async def list_builtin_tools():
    return {"tools": [t.model_dump() for t in BUILTIN_TOOLS]}


def load_builtin_permissions() -> dict[str, str]:
    if not os.path.exists(BUILTIN_PERMS_PATH):
        return {}
    with open(BUILTIN_PERMS_PATH) as f:
        return json.load(f)


def save_builtin_permissions(perms: dict[str, str]):
    os.makedirs(os.path.dirname(BUILTIN_PERMS_PATH), exist_ok=True)
    with open(BUILTIN_PERMS_PATH, "w") as f:
        json.dump(perms, f, indent=2)


@tools_lib.router.get("/builtin/permissions")
async def get_builtin_permissions():
    return {"permissions": load_builtin_permissions()}


@tools_lib.router.put("/builtin/permissions")
async def update_builtin_permissions(body: dict):
    valid_tools = {t.name for t in BUILTIN_TOOLS}
    valid_policies = {"always_allow", "ask", "deny"}
    perms = load_builtin_permissions()
    for name, policy in body.get("permissions", {}).items():
        if name in valid_tools and policy in valid_policies:
            perms[name] = policy
    save_builtin_permissions(perms)
    return {"permissions": perms}


@tools_lib.router.get("/list")
async def list_tools():
    return {"tools": [t.model_dump() for t in _load_all()]}


@tools_lib.router.get("/oauth/callback")
async def oauth_callback(code: str = Query(...), state: str = Query("")):
    # Backward compat: old state was just tool_id, new state is "provider:tool_id"
    tool_id = _pending_oauth.pop(state, None)
    if not tool_id:
        # Try legacy format (state = tool_id directly)
        tool_id = _pending_oauth.pop(state.split(":")[-1] if ":" in state else state, None)
    if not tool_id:
        return HTMLResponse("<html><body><h2>Invalid OAuth state</h2></body></html>", status_code=400)

    tool = _load(tool_id)
    provider = _resolve_oauth_provider(tool)

    client_id = os.environ.get(provider.client_id_env, "")
    client_secret = os.environ.get(provider.client_secret_env, "")
    _port = os.environ.get("OPENSWARM_PORT", "8324")
    redirect_uri = f"http://localhost:{_port}/api/tools/oauth/callback"

    # Build token exchange request based on provider's auth method
    token_data: dict[str, str] = {
        "code": code,
        "redirect_uri": redirect_uri,
        "grant_type": "authorization_code",
    }
    headers: dict[str, str] = {}

    if provider.token_auth_method == "basic":
        # Spotify, etc: Basic Auth header, credentials in form body
        creds = base64.b64encode(f"{client_id}:{client_secret}".encode()).decode()
        headers["Authorization"] = f"Basic {creds}"
    elif provider.token_auth_method == "basic_json":
        # Notion: Basic Auth header, JSON body
        creds = base64.b64encode(f"{client_id}:{client_secret}".encode()).decode()
        headers["Authorization"] = f"Basic {creds}"
        headers["Content-Type"] = "application/json"
    else:
        # Default: credentials as form data fields
        token_data["client_id"] = client_id
        token_data["client_secret"] = client_secret

    # GitHub requires Accept: application/json
    if (tool.oauth_provider or "google") == "github":
        headers["Accept"] = "application/json"

    # PKCE: include code_verifier if we stored one
    code_verifier = _pending_pkce.pop(state, None)
    if code_verifier:
        token_data["code_verifier"] = code_verifier

    async with httpx.AsyncClient(timeout=15.0) as client:
        if provider.token_auth_method == "basic_json":
            resp = await client.post(provider.token_url, json=token_data, headers=headers)
        else:
            resp = await client.post(provider.token_url, data=token_data, headers=headers)

    if resp.status_code != 200:
        logger.warning(f"OAuth token exchange failed: {resp.text}")
        return HTMLResponse(f"<html><body><h2>Token exchange failed</h2><pre>{resp.text}</pre></body></html>", status_code=400)

    tokens = resp.json()

    # Extract access_token, handling nested responses (e.g., Slack)
    access_token = tokens.get("access_token", "")
    if provider.token_response_path and not access_token:
        # Walk nested path like "authed_user.access_token"
        obj = tokens
        for part in provider.token_response_path.split("."):
            obj = obj.get(part, {}) if isinstance(obj, dict) else ""
        if isinstance(obj, str) and obj:
            access_token = obj

    tool.oauth_tokens = {
        "access_token": access_token,
        "refresh_token": tokens.get("refresh_token", ""),
        "token_expiry": time.time() + tokens.get("expires_in", 3600),
    }

    # Extract extra fields (e.g., Slack team_id)
    for response_path, env_var in provider.extra_token_fields.items():
        obj: Any = tokens
        for part in response_path.split("."):
            obj = obj.get(part, "") if isinstance(obj, dict) else ""
        if obj:
            tool.oauth_tokens[env_var] = str(obj)

    tool.auth_status = "connected"

    if access_token and provider.userinfo_url:
        try:
            async with httpx.AsyncClient(timeout=10.0) as info_client:
                info_resp = await info_client.get(
                    provider.userinfo_url,
                    headers={"Authorization": f"Bearer {access_token}"},
                )
            if info_resp.status_code == 200:
                tool.connected_account_email = info_resp.json().get(provider.userinfo_field)
        except Exception as e:
            logger.warning(f"Failed to fetch userinfo for {tool.oauth_provider or 'google'}: {e}")

    # Notion: extract workspace name from token response
    if (tool.oauth_provider or "google") == "notion" and not tool.connected_account_email:
        workspace_name = tokens.get("workspace_name")
        if workspace_name:
            tool.connected_account_email = workspace_name

    _save(tool)

    return HTMLResponse("""
    <html><body>
    <h2 style="font-family:sans-serif;color:#22c55e">Connected successfully!</h2>
    <p style="font-family:sans-serif;color:#666">You can close this window.</p>
    <script>
      if (window.opener) window.opener.postMessage({type:'oauth_complete', tool_id:'""" + tool_id + """'}, '*');
      setTimeout(() => window.close(), 1500);
    </script>
    </body></html>
    """)


@tools_lib.router.get("/{tool_id}")
async def get_tool(tool_id: str):
    return _load(tool_id).model_dump()


@tools_lib.router.post("/create")
async def create_tool(body: ToolCreate):
    tool = ToolDefinition(
        name=body.name,
        description=body.description,
        command=body.command,
        mcp_config=body.mcp_config,
        credentials=body.credentials,
        auth_type=body.auth_type,
        auth_status=body.auth_status,
        oauth_provider=body.oauth_provider,
    )
    _save(tool)
    return {"ok": True, "tool": tool.model_dump()}


@tools_lib.router.put("/{tool_id}")
async def update_tool(tool_id: str, body: ToolUpdate):
    tool = _load(tool_id)
    for k, v in body.model_dump(exclude_none=True).items():
        setattr(tool, k, v)

    _save(tool)
    return {"ok": True, "tool": tool.model_dump()}


@tools_lib.router.delete("/{tool_id}")
async def delete_tool(tool_id: str):
    path = os.path.join(DATA_DIR, f"{tool_id}.json")
    if os.path.exists(path):
        os.remove(path)
    return {"ok": True}


# ---------------------------------------------------------------------------
# MCP config derivation
# ---------------------------------------------------------------------------

from backend.apps.common.mcp_utils import sanitize_server_name as _sanitize_server_name


def _extra_bin_dirs() -> list[str]:
    """Well-known user-local bin directories that may not be on PATH in packaged apps."""
    home = os.path.expanduser("~")
    # Bundled uv-bin (ships uvx for non-dev users)
    _backend = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    dirs = [
        os.path.join(_backend, "uv-bin"),
        os.path.join(home, ".bun", "bin"),
        os.path.join(home, ".cargo", "bin"),
        os.path.join(home, ".local", "bin"),
        os.path.join(home, ".volta", "bin"),
        "/opt/homebrew/bin",
        "/usr/local/bin",
    ]
    # nvm: pick the newest installed node version
    nvm_node = os.path.join(home, ".nvm", "versions", "node")
    try:
        if os.path.isdir(nvm_node):
            versions = sorted(os.listdir(nvm_node), reverse=True)
            if versions:
                dirs.insert(0, os.path.join(nvm_node, versions[0], "bin"))
    except OSError:
        pass
    # fnm
    fnm_bin = os.path.join(home, "Library", "Application Support", "fnm", "aliases", "default", "bin")
    if os.path.isdir(fnm_bin):
        dirs.insert(0, fnm_bin)
    return dirs


def _resolve_command(command: str) -> str | None:
    """Find a command on PATH, falling back to common user-local bin directories
    and bundled binaries (uv-bin for uvx/uv)."""
    found = shutil.which(command)
    if found:
        return found
    for d in _extra_bin_dirs():
        candidate = os.path.join(d, command)
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    # Check bundled uv-bin directory (ships uv/uvx for non-dev users)
    _backend = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    _is_packaged = os.environ.get("OPENSWARM_PACKAGED") == "1"
    if _is_packaged:
        # In packaged app: <resources>/backend/uv-bin/
        candidate = os.path.join(_backend, "uv-bin", command)
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    else:
        # In dev: backend/uv-bin/
        candidate = os.path.join(_backend, "uv-bin", command)
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return None


def _augmented_path() -> str:
    """Return PATH with extra bin dirs prepended (for child process environments)."""
    extra = [d for d in _extra_bin_dirs() if os.path.isdir(d)]
    current = os.environ.get("PATH", "")
    seen: set[str] = set()
    parts: list[str] = []
    for p in extra + current.split(os.pathsep):
        if p and p not in seen:
            seen.add(p)
            parts.append(p)
    return os.pathsep.join(parts)


def derive_mcp_config(tool: ToolDefinition) -> Optional[dict]:
    """Build the claude_agent_sdk mcp_servers config entry for a tool.

    Returns None if the tool cannot be configured (e.g. missing data).
    """
    if not tool.mcp_config:
        return None

    config: dict = dict(tool.mcp_config)

    if tool.credentials:
        if config.get("type") in ("http", "sse"):
            headers = config.setdefault("headers", {})
            for key, val in tool.credentials.items():
                if key.lower() in ("authorization", "api_key", "api-key"):
                    headers.setdefault("Authorization", f"Bearer {val}")
        else:
            env = config.setdefault("env", {})
            env.update(tool.credentials)

    if tool.auth_type == "oauth2" and tool.oauth_tokens.get("access_token"):
        if config.get("type") in ("http", "sse"):
            headers = config.setdefault("headers", {})
            headers["Authorization"] = f"Bearer {tool.oauth_tokens['access_token']}"
        else:
            env = config.setdefault("env", {})
            provider_key = tool.oauth_provider or "google"
            provider = OAUTH_PROVIDERS.get(provider_key)
            if provider:
                for token_field, env_var in provider.token_env_mapping.items():
                    if token_field.startswith("_client_id"):
                        val = os.environ.get(provider.client_id_env, "")
                    elif token_field.startswith("_client_secret"):
                        val = os.environ.get(provider.client_secret_env, "")
                    else:
                        val = tool.oauth_tokens.get(token_field, "")
                    if val:
                        # Apply value transforms (e.g., Notion needs JSON headers)
                        if provider.env_value_transform == "notion_headers" and token_field == "access_token":
                            val = json.dumps({
                                "Authorization": f"Bearer {val}",
                                "Notion-Version": "2022-06-28",
                            })
                        env[env_var] = val
                # Inject extra token fields (e.g., Slack SLACK_TEAM_ID)
                for _, env_var in provider.extra_token_fields.items():
                    val = tool.oauth_tokens.get(env_var, "")
                    if val:
                        env[env_var] = val
                # Figma: inject token as CLI arg (it doesn't read env vars)
                if provider_key == "figma" and tool.oauth_tokens.get("access_token"):
                    args = config.get("args", [])
                    if "--figma-api-key" not in args:
                        config["args"] = args + ["--figma-api-key", tool.oauth_tokens["access_token"]]
            else:
                # Fallback: inject generic access token
                env["OAUTH_ACCESS_TOKEN"] = tool.oauth_tokens["access_token"]

    if config.get("type") == "stdio":
        if config.get("command"):
            resolved = _resolve_command(config["command"])
            if resolved:
                config["command"] = resolved
            else:
                logger.warning(f"Command '{config['command']}' not found on PATH or bundled directories")
        env = config.setdefault("env", {})
        env.setdefault("PATH", _augmented_path())
        env.setdefault("PYTHONPATH", "")
        # Point uv/uvx at our bundled Python — avoids macOS CLT popup on fresh Macs
        # and avoids downloading Python at runtime
        _is_packaged = os.environ.get("OPENSWARM_PACKAGED") == "1"
        if _is_packaged:
            _resources = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
            _bundled_python = os.path.join(_resources, "python-env", "bin", "python3")
            if os.path.exists(_bundled_python):
                env.setdefault("UV_PYTHON", _bundled_python)
        else:
            _backend = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
            _venv_python = os.path.join(_backend, ".venv", "bin", "python3")
            if os.path.exists(_venv_python):
                env.setdefault("UV_PYTHON", _venv_python)

    return config


_READ_PREFIXES = ("get", "list", "read", "search", "fetch", "find", "query", "count", "check", "describe", "show", "download", "browse", "analy", "explain")
_WRITE_PREFIXES = ("create", "write", "delete", "update", "send", "remove", "modify", "add", "set", "put", "post", "patch", "insert", "move", "copy", "rename", "archive", "trash", "publish", "approve", "reject")


_SERVICE_RULES: list[tuple[list[str], str, str]] = [
    # (keywords, service_name, group)
    # Google Workspace
    (["gmail"], "Gmail", "Google"),
    (["drive"], "Drive", "Google"),
    (["calendar", "event", "freebusy"], "Calendar", "Google"),
    (["spreadsheet", "sheet"], "Sheets", "Google"),
    (["doc", "paragraph", "table"], "Docs", "Google"),
    (["chat", "space", "reaction", "message"], "Chat", "Google"),
    (["form", "publish_settings"], "Forms", "Google"),
    (["presentation", "slide", "page"], "Slides", "Google"),
    (["task_list", "task"], "Tasks", "Google"),
    (["contact"], "Contacts", "Google"),
    (["script", "deployment", "version", "trigger"], "Apps Script", "Google"),
    (["search_custom", "search_engine"], "Search", "Google"),
    # Reddit
    (["subreddit"], "Subreddits", "Reddit"),
    (["search_reddit"], "Search", "Reddit"),
    (["post_detail"], "Posts", "Reddit"),
    (["user_analysis"], "Users", "Reddit"),
    (["reddit_explain"], "Reference", "Reddit"),
    # Sequential Thinking
    (["sequentialthinking", "thinking"], "Thinking", "Sequential Thinking"),
    # Memory (knowledge graph)
    (["create_entities", "create_relations", "add_observations", "delete_entities",
      "delete_observations", "delete_relations", "read_graph", "search_nodes",
      "open_nodes"], "Knowledge Graph", "Memory"),
    # Filesystem
    (["read_file", "read_multiple_files", "write_file", "edit_file",
      "create_directory", "list_directory", "directory_tree", "move_file",
      "search_files", "get_file_info", "list_allowed_directories"], "Files", "Filesystem"),
    # Playwright
    (["browser_navigate", "browser_screenshot", "browser_click", "browser_fill",
      "browser_select", "browser_hover", "browser_evaluate", "browser_console",
      "browser_tab", "browser_close", "browser_resize", "browser_snapshot",
      "browser_wait", "browser_pdf", "browser_drag"], "Browser", "Playwright"),
    # Git
    (["git_status", "git_diff", "git_diff_unstaged", "git_diff_staged",
      "git_commit", "git_log", "git_add", "git_reset", "git_show",
      "git_create_branch", "git_checkout", "git_list_branches", "git_init",
      "git_clone"], "Repository", "Git"),
    # YouTube Transcripts
    (["get_transcript"], "Transcripts", "YouTube"),
    # Desktop Commander
    (["execute_command", "read_output", "force_terminate", "list_sessions",
      "list_processes", "kill_process", "block_command", "unblock_command",
      "read_file", "write_file", "search_code", "list_directory",
      "get_file_info", "edit_block"], "System", "Desktop Commander"),
    # GitHub
    (["repository", "issue", "pull_request", "commit", "branch", "fork", "star",
      "create_issue", "list_issues", "get_issue", "create_pull_request",
      "list_commits", "search_repositories", "create_repository",
      "get_file_contents", "push_files", "create_branch",
      "search_code", "search_issues"], "Repository", "GitHub"),
    # Slack
    (["channel", "slack_message", "thread", "reply", "workspace",
      "list_channels", "post_message", "reply_to_thread", "search_messages",
      "get_channel_history", "get_thread_replies", "get_users",
      "get_user_profile"], "Messaging", "Slack"),
    # Notion
    (["notion_page", "database", "block", "create_page", "update_page",
      "search_pages", "get_page", "get_database", "query_database",
      "create_database", "append_block_children"], "Pages", "Notion"),
    # Spotify
    (["play", "pause", "skip", "playlist", "track", "album", "artist",
      "search_tracks", "get_playlist", "get_currently_playing",
      "add_to_playlist", "create_playlist", "get_recommendations",
      "get_top_items"], "Music", "Spotify"),
    # Figma
    (["figma", "design", "component", "style", "node",
      "get_file", "get_file_nodes", "get_image", "get_comments",
      "get_team_projects", "get_project_files"], "Design", "Figma"),
    # Airtable
    (["airtable", "base", "record", "field", "view",
      "list_records", "get_record", "create_record", "update_record",
      "delete_record", "list_bases", "get_base_schema"], "Data", "Airtable"),
    # HubSpot
    (["hubspot", "contact", "deal", "company", "ticket", "pipeline",
      "crm", "engagement", "association"], "CRM", "HubSpot"),
    # Discord
    (["discord", "guild", "server", "channel_message", "send_message",
      "get_messages", "get_guilds", "get_channels", "add_reaction"], "Messaging", "Discord"),
    # Twitter / X (TweetSave)
    (["tweetsave", "get_tweet", "get_thread", "to_blog", "batch",
      "extract_media"], "Tweets", "Twitter"),
    # Shopify Dev
    (["shopify", "introspect", "graphql", "search_dev_docs", "liquid",
      "polaris", "admin_api", "storefront_api"], "Developer", "Shopify"),
    # Zoom
    (["zoom", "meeting", "recording", "participant", "webinar",
      "create_meeting", "list_meetings", "get_meeting", "delete_meeting",
      "update_meeting"], "Meetings", "Zoom"),
    # Microsoft 365
    (["outlook", "onedrive", "ms365", "microsoft", "mail_folder",
      "email", "calendar_event", "contact", "drive_item"], "Mail & Files", "Microsoft 365"),
]


def _categorize_tool(name: str) -> str:
    lower = name.lower().replace("_", " ").replace("-", " ").strip()
    for word in lower.split():
        for prefix in _READ_PREFIXES:
            if word.startswith(prefix):
                return "read"
        for prefix in _WRITE_PREFIXES:
            if word.startswith(prefix):
                return "write"
    return "write"


def _extract_service(name: str) -> tuple[str, str]:
    """Extract the service and group from a tool name (e.g. 'search_gmail_messages' -> ('Gmail', 'Google'))."""
    lower = name.lower()
    for keywords, display, group in _SERVICE_RULES:
        for kw in keywords:
            if kw in lower:
                return display, group
    return "Other", ""


from backend.apps.common.mcp_utils import parse_sse_json as _parse_sse_json


async def _discover_mcp_tools_http(url: str, headers: dict | None = None) -> list[dict]:
    """Connect to a Streamable HTTP MCP server and call tools/list via JSON-RPC POST."""
    h = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        **(headers or {}),
    }
    async with httpx.AsyncClient(timeout=30.0) as client:
        init_resp = await client.post(url, headers=h, json={
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {"protocolVersion": "2025-03-26", "capabilities": {},
                       "clientInfo": {"name": "self-swarm", "version": "0.1.0"}},
        })
        if init_resp.status_code not in (200, 201):
            raise HTTPException(status_code=502, detail=f"MCP initialize failed: {init_resp.status_code}")

        session_id = init_resp.headers.get("mcp-session-id", "")
        if session_id:
            h["mcp-session-id"] = session_id

        await client.post(url, headers=h, json={
            "jsonrpc": "2.0", "method": "notifications/initialized",
        })

        list_resp = await client.post(url, headers=h, json={
            "jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {},
        })
        if list_resp.status_code not in (200, 201):
            raise HTTPException(status_code=502, detail=f"MCP tools/list failed: {list_resp.status_code}")

        ct = list_resp.headers.get("content-type", "")
        if "text/event-stream" in ct:
            data = _parse_sse_json(list_resp.text)
        else:
            data = list_resp.json()

        if not data:
            raise HTTPException(status_code=502, detail="Empty response from MCP server")

        tools_list = data.get("result", {}).get("tools", [])
        return [{"name": t.get("name", ""), "description": t.get("description", ""), "inputSchema": t.get("inputSchema")} for t in tools_list]


async def _discover_mcp_tools_sse(url: str, headers: dict | None = None) -> list[dict]:
    """Connect to a legacy SSE MCP server (GET event-stream + POST messages) and call tools/list."""
    from mcp.client.sse import sse_client
    from mcp import ClientSession
    from mcp.types import Implementation

    try:
        async with sse_client(
            url=url,
            headers=headers,
            timeout=30,
            sse_read_timeout=30,
        ) as (read_stream, write_stream):
            async with ClientSession(
                read_stream,
                write_stream,
                client_info=Implementation(name="self-swarm", version="0.1.0"),
            ) as session:
                await session.initialize()
                result = await session.list_tools()
                return [{"name": t.name, "description": t.description or "", "inputSchema": t.inputSchema if t.inputSchema else None} for t in result.tools]
    except BaseExceptionGroup as eg:
        first = eg.exceptions[0] if eg.exceptions else eg
        raise HTTPException(status_code=502, detail=f"SSE discovery failed: {first}") from first


async def _discover_mcp_tools_stdio(command: str, args: list[str] | None = None, env: dict | None = None) -> list[dict]:
    """Spawn a stdio MCP server process and call tools/list via JSON-RPC over stdin/stdout."""
    cmd_path = _resolve_command(command)
    if not cmd_path:
        raise HTTPException(status_code=400, detail=f"Command '{command}' not found on PATH or common install locations")

    proc_env = {**os.environ, **(env or {}), "PATH": _augmented_path()}
    proc_env.pop("PYTHONPATH", None)

    proc = await asyncio.create_subprocess_exec(
        cmd_path, *(args or []),
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=proc_env,
        limit=1024 * 1024,  # 1MB buffer for large MCP responses (e.g., MS365 with 87 tools)
    )

    async def _send(msg: dict) -> None:
        line = json.dumps(msg) + "\n"
        proc.stdin.write(line.encode())
        await proc.stdin.drain()

    async def _recv() -> dict:
        """Read JSON-RPC responses, skipping notification lines (no 'id' field)."""
        while True:
            line = await asyncio.wait_for(proc.stdout.readline(), timeout=30.0)
            if not line:
                stderr_out = ""
                try:
                    stderr_out = (await asyncio.wait_for(proc.stderr.read(4096), timeout=2.0)).decode(errors="replace")
                except (asyncio.TimeoutError, Exception):
                    pass
                raise HTTPException(
                    status_code=502,
                    detail=f"MCP stdio process exited unexpectedly{': ' + stderr_out if stderr_out else ''}",
                )
            stripped = line.decode(errors="replace").strip()
            if not stripped:
                continue
            try:
                data = json.loads(stripped)
            except json.JSONDecodeError:
                continue
            if "id" in data:
                return data

    try:
        await _send({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {
                "protocolVersion": "2025-03-26",
                "capabilities": {},
                "clientInfo": {"name": "self-swarm", "version": "0.1.0"},
            },
        })
        await _recv()

        await _send({"jsonrpc": "2.0", "method": "notifications/initialized"})

        await _send({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})
        data = await _recv()

        tools_list = data.get("result", {}).get("tools", [])
        return [{"name": t.get("name", ""), "description": t.get("description", ""), "inputSchema": t.get("inputSchema")} for t in tools_list]

    except HTTPException:
        raise
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="MCP stdio server timed out during discovery")
    finally:
        try:
            proc.stdin.close()
        except Exception:
            pass
        try:
            proc.terminate()
            await asyncio.wait_for(proc.wait(), timeout=5.0)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass


@tools_lib.router.post("/{tool_id}/discover")
async def discover_tools(tool_id: str):
    tool = _load(tool_id)

    if tool.auth_type == "oauth2" and tool.auth_status == "connected":
        refreshed = await refresh_google_token(tool)
        if not refreshed and tool.oauth_tokens.get("access_token"):
            expiry = tool.oauth_tokens.get("token_expiry", 0)
            if time.time() >= expiry - 60:
                client_id = os.environ.get("GOOGLE_OAUTH_CLIENT_ID", "")
                if not client_id:
                    raise HTTPException(
                        status_code=400,
                        detail="OAuth token expired and GOOGLE_OAUTH_CLIENT_ID is not set. "
                               "In the packaged app, create ~/.openswarm.env or "
                               "~/Library/Application Support/OpenSwarm/.env with your Google OAuth credentials.",
                    )
                raise HTTPException(
                    status_code=502,
                    detail="OAuth token expired and refresh failed. Try reconnecting Google.",
                )

    config = derive_mcp_config(tool)
    if not config:
        raise HTTPException(status_code=400, detail="Cannot derive MCP config for tool")

    transport = config.get("type", "")

    try:
        if transport == "stdio":
            command = config.get("command", "")
            if not command:
                raise HTTPException(status_code=400, detail="stdio transport requires a 'command' in MCP config")
            raw_tools = await _discover_mcp_tools_stdio(
                command=command,
                args=config.get("args"),
                env=config.get("env"),
            )
        elif transport in ("http", "sse") or config.get("url"):
            url = config.get("url", "")
            if not url:
                raise HTTPException(status_code=400, detail="HTTP/SSE transport requires a 'url' in MCP config")
            if transport == "sse":
                raw_tools = await _discover_mcp_tools_sse(url, config.get("headers"))
            else:
                try:
                    raw_tools = await _discover_mcp_tools_http(url, config.get("headers"))
                except HTTPException:
                    logger.info(f"Streamable HTTP failed for {tool.name}, retrying with SSE transport")
                    raw_tools = await _discover_mcp_tools_sse(url, config.get("headers"))
        else:
            raise HTTPException(status_code=400, detail=f"Unsupported MCP transport type: '{transport}'. Use 'stdio', 'http', or 'sse'.")
    except HTTPException:
        raise
    except Exception as e:
        msg = str(e).strip()
        if not msg:
            msg = type(e).__name__
        logger.warning(f"MCP tool discovery failed for {tool.name}: {msg}", exc_info=True)
        raise HTTPException(status_code=502, detail=f"Discovery failed: {msg}")

    services: dict[str, dict[str, list[str]]] = {}
    service_groups: dict[str, list[str]] = {}
    permissions: dict[str, Any] = {}

    for t in raw_tools:
        name = t["name"]
        cat = _categorize_tool(name)
        svc, group = _extract_service(name)
        if svc not in services:
            services[svc] = {"read": [], "write": []}
        services[svc][cat].append(name)
        permissions[name] = tool.tool_permissions.get(name, "ask")
        if group:
            service_groups.setdefault(group, [])
            if svc not in service_groups[group]:
                service_groups[group].append(svc)

    all_read = [n for s in services.values() for n in s["read"]]
    all_write = [n for s in services.values() for n in s["write"]]
    permissions["_categories"] = {"read": all_read, "write": all_write}
    permissions["_services"] = services
    permissions["_service_groups"] = service_groups
    permissions["_tool_descriptions"] = {t["name"]: t["description"] for t in raw_tools}
    permissions["_tool_schemas"] = {t["name"]: t.get("inputSchema") for t in raw_tools if t.get("inputSchema")}

    tool.tool_permissions = permissions
    _save(tool)

    return {"ok": True, "tool": tool.model_dump()}


@tools_lib.router.post("/{tool_id}/oauth/disconnect")
async def oauth_disconnect(tool_id: str):
    """Clear OAuth tokens and reset auth status so the user can reconnect with a different account."""
    tool = _load(tool_id)
    access_token = tool.oauth_tokens.get("access_token")

    if access_token:
        provider = _resolve_oauth_provider(tool)
        revoke_url = provider.revoke_url or "https://oauth2.googleapis.com/revoke"
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                await client.post(
                    revoke_url,
                    params={"token": access_token},
                    headers={"Content-Type": "application/x-www-form-urlencoded"},
                )
        except Exception as e:
            logger.warning(f"Failed to revoke token for tool {tool.id}: {e}")

    tool.oauth_tokens = {}
    tool.auth_status = "configured"
    tool.connected_account_email = None
    _save(tool)
    return {"ok": True, "tool": tool.model_dump()}


@tools_lib.router.post("/{tool_id}/oauth/start")
async def oauth_start(tool_id: str):
    tool = _load(tool_id)
    provider = _resolve_oauth_provider(tool)

    client_id = os.environ.get(provider.client_id_env, "")
    if not client_id:
        raise HTTPException(status_code=400, detail=f"{provider.client_id_env} not set in backend .env")

    _port = os.environ.get("OPENSWARM_PORT", "8324")
    redirect_uri = f"http://localhost:{_port}/api/tools/oauth/callback"
    provider_key = tool.oauth_provider or "google"
    state = f"{provider_key}:{tool_id}"

    _pending_oauth[state] = tool_id

    params = {
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "state": state,
        **provider.extra_auth_params,
    }
    if provider.scopes:
        params["scope"] = " ".join(provider.scopes)

    # PKCE support (required by Airtable, etc.)
    if provider.pkce_required:
        code_verifier = secrets.token_urlsafe(64)
        code_challenge = base64.urlsafe_b64encode(
            hashlib.sha256(code_verifier.encode()).digest()
        ).rstrip(b"=").decode()
        params["code_challenge"] = code_challenge
        params["code_challenge_method"] = "S256"
        _pending_pkce[state] = code_verifier

    auth_url = f"{provider.auth_url}?{urlencode(params)}"
    return {"auth_url": auth_url}


async def refresh_oauth_token(tool: ToolDefinition) -> Optional[str]:
    """Refresh an expired OAuth token. Returns the fresh access_token or None."""
    if tool.auth_type != "oauth2":
        return None
    refresh_token = tool.oauth_tokens.get("refresh_token")
    if not refresh_token:
        return None
    expiry = tool.oauth_tokens.get("token_expiry", 0)
    if time.time() < expiry - 60:
        return tool.oauth_tokens.get("access_token")

    provider = _resolve_oauth_provider(tool)
    client_id = os.environ.get(provider.client_id_env, "")
    client_secret = os.environ.get(provider.client_secret_env, "")
    if not client_id or not client_secret:
        return None

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(provider.token_url, data={
                "client_id": client_id,
                "client_secret": client_secret,
                "refresh_token": refresh_token,
                "grant_type": "refresh_token",
            })
        if resp.status_code == 200:
            data = resp.json()
            new_token = data["access_token"]
            tool.oauth_tokens["access_token"] = new_token
            tool.oauth_tokens["token_expiry"] = time.time() + data.get("expires_in", 3600)

            if not tool.connected_account_email and provider.userinfo_url:
                try:
                    async with httpx.AsyncClient(timeout=10.0) as info_client:
                        info_resp = await info_client.get(
                            provider.userinfo_url,
                            headers={"Authorization": f"Bearer {new_token}"},
                        )
                    if info_resp.status_code == 200:
                        tool.connected_account_email = info_resp.json().get(provider.userinfo_field)
                except Exception:
                    pass

            _save(tool)
            return new_token
    except Exception as e:
        logger.warning(f"OAuth token refresh failed for tool {tool.id}: {e}")
    return None


# Backward-compatible alias
refresh_google_token = refresh_oauth_token
