"""Tool CRUD endpoints and builtin permission management."""

from __future__ import annotations

import json
import os

from fastapi import HTTPException

from backend.apps.common.json_store import JsonStore
from backend.apps.tools_lib.models import ToolDefinition, ToolCreate, ToolUpdate, BUILTIN_TOOLS
from backend.config.paths import TOOLS_DIR as DATA_DIR, BUILTIN_PERMISSIONS_PATH as BUILTIN_PERMS_PATH

_store = JsonStore(ToolDefinition, DATA_DIR, not_found_detail="Tool not found")

_load_all = _store.load_all
_save = _store.save
_load = _store.load


def load_builtin_permissions() -> dict[str, str]:
    if not os.path.exists(BUILTIN_PERMS_PATH):
        return {}
    with open(BUILTIN_PERMS_PATH) as f:
        return json.load(f)


def save_builtin_permissions(perms: dict[str, str]):
    os.makedirs(os.path.dirname(BUILTIN_PERMS_PATH), exist_ok=True)
    with open(BUILTIN_PERMS_PATH, "w") as f:
        json.dump(perms, f, indent=2)


async def list_builtin_tools():
    return {"tools": [t.model_dump() for t in BUILTIN_TOOLS]}


async def get_builtin_permissions():
    return {"permissions": load_builtin_permissions()}


async def update_builtin_permissions(body: dict):
    valid_tools = {t.name for t in BUILTIN_TOOLS}
    valid_policies = {"always_allow", "ask", "deny"}
    perms = load_builtin_permissions()
    for name, policy in body.get("permissions", {}).items():
        if name in valid_tools and policy in valid_policies:
            perms[name] = policy
    save_builtin_permissions(perms)
    return {"permissions": perms}


async def list_tools():
    return {"tools": [t.model_dump() for t in _load_all()]}


async def get_tool(tool_id: str):
    return _load(tool_id).model_dump()


async def create_tool(body: ToolCreate):
    tool = ToolDefinition(
        name=body.name, description=body.description,
        command=body.command, mcp_config=body.mcp_config,
        credentials=body.credentials, auth_type=body.auth_type,
        auth_status=body.auth_status, oauth_provider=body.oauth_provider,
    )
    _save(tool)
    return {"ok": True, "tool": tool.model_dump()}


async def update_tool(tool_id: str, body: ToolUpdate):
    tool = _load(tool_id)
    for k, v in body.model_dump(exclude_none=True).items():
        setattr(tool, k, v)
    _save(tool)
    return {"ok": True, "tool": tool.model_dump()}


async def delete_tool(tool_id: str):
    path = os.path.join(DATA_DIR, f"{tool_id}.json")
    if os.path.exists(path):
        os.remove(path)
    return {"ok": True}
