import json
from typing import Optional
import httpx
from typeguard import typechecked
from backend.apps.tools.discover_tools.DiscoveryError import DiscoveryError

# TODO: better type specing of return value
@typechecked
def p_parse_sse_json(text: str) -> Optional[dict]:
    for line in text.splitlines():
        stripped: str = line.strip()
        if stripped.startswith("data:"):
            payload: str = stripped[len("data:"):].strip()
            if payload:
                try:
                    return json.loads(payload)
                except json.JSONDecodeError:
                    continue
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return None


# TODO: better type specing throughout this whole func
@typechecked
async def discover_mcp_tools_http(url: str, headers: dict | None = None) -> list[dict]:
    """Discover tools via streamable HTTP JSON-RPC."""
    h: dict[str, str] = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        **(headers or {}),
    }
    async with httpx.AsyncClient(timeout=30.0) as client:
        init_resp: httpx.Response = await client.post(url, headers=h, json={
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {
                "protocolVersion": "2025-03-26",
                "capabilities": {},
                "clientInfo": {"name": "openswarm", "version": "0.1.0"},
            },
        })
        if init_resp.status_code not in (200, 201):
            raise DiscoveryError(f"MCP initialize failed: {init_resp.status_code}")

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
            raise DiscoveryError(f"MCP tools/list failed: {list_resp.status_code}")

        ct = list_resp.headers.get("content-type", "")
        data: Optional[dict] = p_parse_sse_json(list_resp.text) if "text/event-stream" in ct else list_resp.json()

        if not data:
            raise DiscoveryError("Empty response from MCP server")

        tools_list = data.get("result", {}).get("tools", [])
        return [
            {"name": t.get("name", ""), "description": t.get("description", ""), "inputSchema": t.get("inputSchema")}
            for t in tools_list
        ]