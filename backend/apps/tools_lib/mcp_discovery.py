"""MCP tool discovery — HTTP, SSE, and stdio transports."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from typing import Any

import httpx
from fastapi import HTTPException

from backend.apps.tools_lib.mcp_config import (
    _resolve_command, _augmented_path, derive_mcp_config,
)
from backend.apps.tools_lib.classification import _categorize_tool, _extract_service
from backend.apps.common.mcp_utils import parse_sse_json as _parse_sse_json

logger = logging.getLogger(__name__)


async def _discover_mcp_tools_http(url: str, headers: dict | None = None) -> list[dict]:
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
    from mcp.client.sse import sse_client
    from mcp import ClientSession
    from mcp.types import Implementation

    try:
        async with sse_client(url=url, headers=headers, timeout=30, sse_read_timeout=30) as (read_stream, write_stream):
            async with ClientSession(
                read_stream, write_stream,
                client_info=Implementation(name="self-swarm", version="0.1.0"),
            ) as session:
                await session.initialize()
                result = await session.list_tools()
                return [{"name": t.name, "description": t.description or "", "inputSchema": t.inputSchema if t.inputSchema else None} for t in result.tools]
    except BaseExceptionGroup as eg:
        first = eg.exceptions[0] if eg.exceptions else eg
        raise HTTPException(status_code=502, detail=f"SSE discovery failed: {first}") from first


async def _discover_mcp_tools_stdio(command: str, args: list[str] | None = None, env: dict | None = None) -> list[dict]:
    cmd_path = _resolve_command(command)
    if not cmd_path:
        raise HTTPException(status_code=400, detail=f"Command '{command}' not found on PATH or common install locations")

    proc_env = {**os.environ, **(env or {}), "PATH": _augmented_path()}
    proc_env.pop("PYTHONPATH", None)

    proc = await asyncio.create_subprocess_exec(
        cmd_path, *(args or []),
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE, env=proc_env, limit=1024 * 1024,
    )

    async def _send(msg: dict) -> None:
        line = json.dumps(msg) + "\n"
        proc.stdin.write(line.encode())
        await proc.stdin.drain()

    async def _recv() -> dict:
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
            "params": {"protocolVersion": "2025-03-26", "capabilities": {},
                       "clientInfo": {"name": "self-swarm", "version": "0.1.0"}},
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


async def discover_tools(tool_id: str):
    from backend.apps.tools_lib.oauth import refresh_oauth_token
    from backend.apps.tools_lib.routes import _store

    tool = _store.load(tool_id)

    if tool.auth_type == "oauth2" and tool.auth_status == "connected":
        refreshed = await refresh_oauth_token(tool)
        if not refreshed and tool.oauth_tokens.get("access_token"):
            expiry = tool.oauth_tokens.get("token_expiry", 0)
            if time.time() >= expiry - 60:
                client_id = os.environ.get("GOOGLE_OAUTH_CLIENT_ID", "")
                if not client_id:
                    raise HTTPException(
                        status_code=400,
                        detail="OAuth token expired and GOOGLE_OAUTH_CLIENT_ID is not set.",
                    )
                raise HTTPException(status_code=502, detail="OAuth token expired and refresh failed. Try reconnecting Google.")

    config = derive_mcp_config(tool)
    if not config:
        raise HTTPException(status_code=400, detail="Cannot derive MCP config for tool")

    transport = config.get("type", "")

    try:
        if transport == "stdio":
            command = config.get("command", "")
            if not command:
                raise HTTPException(status_code=400, detail="stdio transport requires a 'command' in MCP config")
            raw_tools = await _discover_mcp_tools_stdio(command=command, args=config.get("args"), env=config.get("env"))
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
            raise HTTPException(status_code=400, detail=f"Unsupported MCP transport type: '{transport}'.")
    except HTTPException:
        raise
    except Exception as e:
        msg = str(e).strip() or type(e).__name__
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
    _store.save(tool)

    return {"ok": True, "tool": tool.model_dump()}
