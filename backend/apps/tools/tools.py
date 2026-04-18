"""Tools sub-app — CRUD for user-installed MCP tools, builtin permissions, and discovery."""

from typing_extensions import List
from claude_agent_sdk.types import McpServerConfig
from pydantic import BaseModel, Field
import json
import os
import time
from contextlib import asynccontextmanager
from typing import Any, Optional

from fastapi import HTTPException, Query
from fastapi.responses import HTMLResponse

from backend.config.Apps import SubApp
from backend.config.paths import DB_ROOT
from backend.core.db.PydanticStore import PydanticStore
from backend.apps.tools.shared_utils.ToolDefinition import ToolDefinition
from backend.apps.tools.discover_tools.discover_tools import discover_tools
from backend.apps.tools.discover_tools.DiscoveryError import DiscoveryError, DiscoveryConfigError
from backend.apps.tools.tool_definition_to_mcp_tool.tool_definition_to_mcp_tool import tool_definition_to_mcp_tool
from backend.apps.tools.OAuthService.OAuthService import OAuthService
from backend.apps.tools.OAuthService.OAUTH_PROVIDERS.OAUTH_PROVIDERS import OAUTH_PROVIDERS
from backend.apps.tools.builtin_tools import BUILTIN_TOOLS
from backend.core.tools.shared_structs.TOOL_PERMISSIONS import TOOL_PERMISSIONS
from backend.core.tools.shared_structs.Toolkit import Toolkit
from backend.core.tools.shared_structs.Tool import Tool
from backend.core.tools.shared_structs.MCP_Tool import MCP_Tool
from swarm_debug import debug
from typeguard import typechecked

TOOLS_DIR = os.path.join(DB_ROOT, "tools")
BUILTIN_PERMS_PATH = os.path.join(TOOLS_DIR, "builtin_permissions.json")

TOOL_STORE: PydanticStore[ToolDefinition] = PydanticStore[ToolDefinition](
    model_cls=ToolDefinition,
    data_dir=TOOLS_DIR,
    id_field="id",
    dump_mode="json",
    not_found_detail="Tool not found",
)

OAUTH_SERVICE: Optional[OAuthService] = None

@asynccontextmanager
async def tools_lifespan():
    global OAUTH_SERVICE
    os.makedirs(TOOLS_DIR, exist_ok=True)
    OAUTH_SERVICE = OAuthService(store=TOOL_STORE)
    yield


tools = SubApp("tools", tools_lifespan)


# ---------------------------------------------------------------------------
# Builtin tools
# ---------------------------------------------------------------------------

@tools.router.get("/builtin")
async def list_builtin_tools() -> dict:
    return {"tools": BUILTIN_TOOLS}


def load_builtin_permissions() -> dict[str, TOOL_PERMISSIONS]:
    if not os.path.exists(BUILTIN_PERMS_PATH):
        return {}
    with open(BUILTIN_PERMS_PATH) as f:
        return json.load(f)


def save_builtin_permissions(perms: dict[str, str]) -> None:
    os.makedirs(os.path.dirname(BUILTIN_PERMS_PATH), exist_ok=True)
    with open(BUILTIN_PERMS_PATH, "w") as f:
        json.dump(perms, f, indent=2)


@tools.router.get("/get_builtin_permissions")
async def get_builtin_permissions() -> dict:
    return {"permissions": load_builtin_permissions()}


@tools.router.put("/update_builtin_permissions")
async def update_builtin_permissions(body: dict) -> dict:
    valid_names = {t["name"] for t in BUILTIN_TOOLS}
    valid_policies = {"allow", "ask", "deny"}
    perms = load_builtin_permissions()
    for name, policy in body.get("permissions", {}).items():
        if name in valid_names and policy in valid_policies:
            perms[name] = policy
    save_builtin_permissions(perms)
    return {"permissions": perms}


# ---------------------------------------------------------------------------
# User-installed tool CRUD
# ---------------------------------------------------------------------------

@tools.router.get("/list")
async def list_tools() -> dict:
    return {"tools": [t.model_dump() for t in TOOL_STORE.load_all()]}


class ToolCreate(BaseModel):
    name: str
    description: str = ""
    command: str = ""
    mcp_config: dict[str, Any] = Field(default_factory=dict)
    credentials: dict[str, str] = Field(default_factory=dict)
    auth_type: str = "none"
    auth_status: str = "none"
    oauth_provider: Optional[str] = None

@tools.router.post("/create")
async def create_tool(body: ToolCreate) -> dict:
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
    TOOL_STORE.save(tool)
    return {"ok": True, "tool": tool.model_dump()}


@tools.router.get("/{tool_id}")
async def get_tool(tool_id: str) -> dict:
    return TOOL_STORE.load(tool_id).model_dump()


class ToolUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    command: Optional[str] = None
    mcp_config: Optional[dict[str, Any]] = None
    credentials: Optional[dict[str, str]] = None
    auth_type: Optional[str] = None
    auth_status: Optional[str] = None
    oauth_provider: Optional[str] = None
    oauth_tokens: Optional[dict[str, Any]] = None
    tool_permissions: Optional[dict[str, TOOL_PERMISSIONS]] = None
    connected_account_email: Optional[str] = None
    enabled: Optional[bool] = None

@tools.router.put("/{tool_id}")
async def update_tool(tool_id: str, body: ToolUpdate) -> dict:
    tool = TOOL_STORE.load(tool_id)
    for k, v in body.model_dump(exclude_none=True).items():
        setattr(tool, k, v)
    TOOL_STORE.save(tool)
    return {"ok": True, "tool": tool.model_dump()}


@tools.router.delete("/{tool_id}")
async def delete_tool(tool_id: str) -> dict:
    TOOL_STORE.delete(tool_id)
    return {"ok": True}


# ---------------------------------------------------------------------------
# Discovery
# ---------------------------------------------------------------------------

@tools.router.post("/{tool_id}/discover")
async def discover(tool_id: str) -> dict:
    tool = TOOL_STORE.load(tool_id)

    if tool.auth_type == "oauth2" and tool.auth_status == "connected":
        assert OAUTH_SERVICE is not None, "OAuthService not initialized"
        refreshed = await OAUTH_SERVICE.refresh_token(tool)
        if not refreshed and tool.oauth_tokens.get("access_token"):
            expiry = tool.oauth_tokens.get("token_expiry", 0)
            if isinstance(expiry, (int, float)) and time.time() >= expiry - 60:
                raise HTTPException(
                    status_code=502,
                    detail="OAuth token expired and refresh failed. Try reconnecting.",
                )

    mcp_tool = tool_definition_to_mcp_tool(tool, oauth_providers=OAUTH_PROVIDERS)
    if not mcp_tool:
        raise HTTPException(status_code=400, detail="Cannot derive MCP config for tool")

    config = list[McpServerConfig](mcp_tool.to_mcp_server_config().values())[0]
    if isinstance(config, dict):
        discovery_config = config
    else:
        raise HTTPException(status_code=400, detail="Unexpected MCP config format")

    try:
        raw_tools = await discover_tools(discovery_config, tool_name=tool.name)
    except DiscoveryConfigError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except DiscoveryError as e:
        raise HTTPException(status_code=502, detail=str(e))
    except Exception as e:
        msg = str(e).strip() or type(e).__name__
        debug(f"MCP tool discovery failed for {tool.name}: {msg}")
        raise HTTPException(status_code=502, detail=f"Discovery failed: {msg}")

    permissions: dict[str, Any] = {}
    for t in raw_tools:
        name = t["name"]
        permissions[name] = tool.tool_permissions.get(name, "ask")

    permissions["_tool_descriptions"] = {t["name"]: t["description"] for t in raw_tools}
    permissions["_tool_schemas"] = {
        t["name"]: t.get("inputSchema") for t in raw_tools if t.get("inputSchema")
    }

    tool.tool_permissions = permissions
    TOOL_STORE.save(tool)

    return {"ok": True, "tool": tool.model_dump()}


@tools.router.get("/load_user_toolkit")
async def load_user_toolkit() -> Optional[Toolkit]:
    """Load all user-installed tools from the store and return them as a Toolkit.

    Returns None if no valid tools could be converted.
    """
    mcp_tools: List[Tool] = []
    for td in TOOL_STORE.load_all():
        if not td.mcp_config or not td.enabled:
            continue
        if td.auth_status not in ("configured", "connected", "none"):
            continue
        mcp_tool: Optional[MCP_Tool] = tool_definition_to_mcp_tool(td, oauth_providers=OAUTH_PROVIDERS)
        if mcp_tool is None:
            continue
        if td.tool_permissions:
            known = set[str](td.tool_descriptions.keys())
            if known:
                denied = {k for k, v in td.tool_permissions.items() if v == "deny"}
                if known <= denied:
                    mcp_tool.permission = "deny"
        mcp_tools.append(mcp_tool)

    if not mcp_tools:
        return None

    return Toolkit(
        name="user_installed",
        description="User-installed MCP tool servers",
        tools=mcp_tools,
    )

# ---------------------------------------------------------------------------
# OAuth
# ---------------------------------------------------------------------------

@tools.router.get("/oauth/callback")
async def oauth_callback(code: str = Query(...), state: str = Query("")) -> HTMLResponse:
    try:
        assert OAUTH_SERVICE is not None, "OAuthService not initialized"
        tool_id, _tool = await OAUTH_SERVICE.handle_callback(code, state)
    except LookupError:
        return HTMLResponse(
            "<html><body><h2>Invalid OAuth state</h2></body></html>",
            status_code=400,
        )
    except RuntimeError as e:
        return HTMLResponse(
            f"<html><body><h2>Token exchange failed</h2><pre>{e}</pre></body></html>",
            status_code=400,
        )

    return HTMLResponse(
        "<html><body>"
        '<h2 style="font-family:sans-serif;color:#22c55e">Connected successfully!</h2>'
        '<p style="font-family:sans-serif;color:#666">You can close this window.</p>'
        "<script>"
        "if (window.opener) window.opener.postMessage({type:'oauth_complete', tool_id:'"
        + tool_id
        + "'}, '*');"
        "setTimeout(() => window.close(), 1500);"
        "</script>"
        "</body></html>"
    )


@tools.router.post("/{tool_id}/oauth/start")
async def oauth_start(tool_id: str) -> dict:
    try:
        assert OAUTH_SERVICE is not None, "OAuthService not initialized"
        auth_url = await OAUTH_SERVICE.start_flow(tool_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"auth_url": auth_url}


@tools.router.post("/{tool_id}/oauth/disconnect")
async def oauth_disconnect(tool_id: str) -> dict:
    assert OAUTH_SERVICE is not None, "OAuthService not initialized"
    tool = await OAUTH_SERVICE.disconnect(tool_id)
    return {"ok": True, "tool": tool.model_dump()}
