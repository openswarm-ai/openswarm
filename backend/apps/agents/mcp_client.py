"""Standalone MCP client manager for agent sessions.

Replaces claude_agent_sdk's internal MCP server management.
One MCPClientManager instance per agent session — manages connections
to stdio/http/sse MCP servers, discovers tools, and routes tool calls.
"""

from __future__ import annotations

import asyncio
import json
import logging
from contextlib import AsyncExitStack
from dataclasses import dataclass, field
from typing import Any

from backend.apps.agents.providers.base import ToolSchema

logger = logging.getLogger(__name__)


@dataclass
class MCPConnection:
    """A live connection to an MCP server."""
    server_name: str
    session: Any  # mcp.ClientSession
    tools: list[ToolSchema] = field(default_factory=list)


class MCPClientManager:
    """Manages connections to MCP servers for a single agent session."""

    def __init__(self):
        self._connections: dict[str, MCPConnection] = {}
        self._exit_stack = AsyncExitStack()
        self._started = False

    async def __aenter__(self):
        await self._exit_stack.__aenter__()
        self._started = True
        return self

    async def __aexit__(self, *exc):
        await self.disconnect_all()
        try:
            await self._exit_stack.__aexit__(*exc)
        except (BaseExceptionGroup, ExceptionGroup, Exception) as e:
            # MCP subprocess cleanup errors are non-fatal
            logger.warning(f"MCP cleanup error (non-fatal): {e}")
        self._started = False

    async def connect(self, server_name: str, config: dict, timeout: float = 30.0) -> list[ToolSchema]:
        """Connect to an MCP server and return its available tools.

        The tools are returned with names prefixed as mcp__<server_name>__<tool_name>.
        """
        transport = config.get("type", "stdio")
        try:
            if transport == "stdio":
                coro = self._connect_stdio(server_name, config)
            elif transport == "sse":
                coro = self._connect_sse(server_name, config)
            elif transport == "http":
                coro = self._connect_http(server_name, config)
            else:
                logger.warning(f"Unsupported MCP transport: {transport} for {server_name}")
                return []

            conn = await asyncio.wait_for(coro, timeout=timeout)
            self._connections[server_name] = conn
            logger.info(f"MCP connected: {server_name} ({len(conn.tools)} tools)")
            return conn.tools

        except asyncio.TimeoutError:
            logger.warning(f"MCP server {server_name} connection timed out after {timeout}s")
            return []
        except Exception as e:
            logger.warning(f"Failed to connect MCP server {server_name}: {e}")
            return []

    async def _connect_stdio(self, server_name: str, config: dict) -> MCPConnection:
        """Connect to a stdio MCP server (spawns a subprocess)."""
        from mcp import ClientSession
        from mcp.client.stdio import stdio_client, StdioServerParameters

        command = config.get("command", "")
        args = config.get("args", [])
        env = config.get("env")

        params = StdioServerParameters(
            command=command,
            args=args,
            env=env,
        )

        transport = await self._exit_stack.enter_async_context(
            stdio_client(params)
        )
        read_stream, write_stream = transport
        session = await self._exit_stack.enter_async_context(
            ClientSession(read_stream, write_stream)
        )
        await session.initialize()

        result = await session.list_tools()
        tools = [
            ToolSchema(
                name=f"mcp__{server_name}__{t.name}",
                description=t.description or "",
                input_schema=t.inputSchema if hasattr(t, "inputSchema") else (t.input_schema if hasattr(t, "input_schema") else {}),
            )
            for t in result.tools
        ]

        return MCPConnection(server_name=server_name, session=session, tools=tools)

    async def _connect_sse(self, server_name: str, config: dict) -> MCPConnection:
        """Connect to an SSE MCP server."""
        from mcp import ClientSession
        from mcp.client.sse import sse_client

        url = config.get("url", "")
        headers = config.get("headers")

        transport = await self._exit_stack.enter_async_context(
            sse_client(url=url, headers=headers, timeout=30, sse_read_timeout=300)
        )
        read_stream, write_stream = transport
        session = await self._exit_stack.enter_async_context(
            ClientSession(read_stream, write_stream)
        )
        await session.initialize()

        result = await session.list_tools()
        tools = [
            ToolSchema(
                name=f"mcp__{server_name}__{t.name}",
                description=t.description or "",
                input_schema=t.inputSchema if hasattr(t, "inputSchema") else (t.input_schema if hasattr(t, "input_schema") else {}),
            )
            for t in result.tools
        ]

        return MCPConnection(server_name=server_name, session=session, tools=tools)

    async def _connect_http(self, server_name: str, config: dict) -> MCPConnection:
        """Connect to a Streamable HTTP MCP server.

        Falls back to SSE if streamable HTTP fails.
        """
        url = config.get("url", "")
        headers = config.get("headers")

        # Try streamable HTTP first, fall back to SSE
        try:
            return await self._connect_http_streamable(server_name, url, headers)
        except Exception as e:
            logger.info(f"Streamable HTTP failed for {server_name}, trying SSE: {e}")
            return await self._connect_sse(server_name, config)

    async def _connect_http_streamable(
        self, server_name: str, url: str, headers: dict | None,
    ) -> MCPConnection:
        """Connect via Streamable HTTP (JSON-RPC POST)."""
        import httpx
        from mcp import ClientSession

        # Use httpx for streamable HTTP — keep client alive in the exit stack
        client = await self._exit_stack.enter_async_context(
            httpx.AsyncClient(timeout=30.0)
        )

        h = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            **(headers or {}),
        }

        # Initialize
        init_resp = await client.post(url, headers=h, json={
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {
                "protocolVersion": "2025-03-26",
                "capabilities": {},
                "clientInfo": {"name": "self-swarm", "version": "0.1.0"},
            },
        })
        if init_resp.status_code not in (200, 201):
            raise ConnectionError(f"MCP initialize failed: {init_resp.status_code}")

        session_id = init_resp.headers.get("mcp-session-id", "")
        if session_id:
            h["mcp-session-id"] = session_id

        # Notify initialized
        await client.post(url, headers=h, json={
            "jsonrpc": "2.0", "method": "notifications/initialized",
        })

        # List tools
        list_resp = await client.post(url, headers=h, json={
            "jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {},
        })
        if list_resp.status_code not in (200, 201):
            raise ConnectionError(f"MCP tools/list failed: {list_resp.status_code}")

        ct = list_resp.headers.get("content-type", "")
        if "text/event-stream" in ct:
            data = self._parse_sse_json(list_resp.text)
        else:
            data = list_resp.json()

        if not data:
            raise ConnectionError("Empty response from MCP server")

        tools_list = data.get("result", {}).get("tools", [])
        tools = [
            ToolSchema(
                name=f"mcp__{server_name}__{t.get('name', '')}",
                description=t.get("description", ""),
                input_schema=t.get("inputSchema", t.get("input_schema", {})),
            )
            for t in tools_list
        ]

        # Store the HTTP client info for call_tool
        conn = MCPConnection(server_name=server_name, session=None, tools=tools)
        conn._http_client = client  # type: ignore[attr-defined]
        conn._http_url = url  # type: ignore[attr-defined]
        conn._http_headers = h  # type: ignore[attr-defined]
        conn._next_id = 3  # type: ignore[attr-defined]
        return conn

    @staticmethod
    def _parse_sse_json(text: str) -> dict | None:
        """Extract JSON from an SSE response body."""
        for line in text.splitlines():
            stripped = line.strip()
            if stripped.startswith("data:"):
                payload = stripped[len("data:"):].strip()
                if payload:
                    try:
                        return json.loads(payload)
                    except json.JSONDecodeError:
                        continue
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            return None

    async def call_tool(
        self, server_name: str, tool_name: str, arguments: dict,
    ) -> list[dict]:
        """Call a tool on a specific MCP server.

        Args:
            server_name: The MCP server name (e.g. "google-workspace")
            tool_name: The bare tool name (without mcp__prefix)
            arguments: Tool input arguments

        Returns:
            List of content blocks: [{"type": "text", "text": "..."}]
        """
        conn = self._connections.get(server_name)
        if not conn:
            return [{"type": "text", "text": f"MCP server {server_name} not connected"}]

        try:
            if conn.session is not None:
                # stdio or SSE — use MCP ClientSession
                result = await conn.session.call_tool(tool_name, arguments)
                return self._format_mcp_result(result)
            elif hasattr(conn, "_http_client"):
                # Streamable HTTP — use JSON-RPC
                return await self._call_tool_http(conn, tool_name, arguments)
            else:
                return [{"type": "text", "text": f"No session for MCP server {server_name}"}]

        except Exception as e:
            logger.warning(f"MCP tool call failed: {server_name}/{tool_name}: {e}")
            return [{"type": "text", "text": f"Error calling {tool_name}: {e}"}]

    async def _call_tool_http(
        self, conn: MCPConnection, tool_name: str, arguments: dict,
    ) -> list[dict]:
        """Call a tool via Streamable HTTP."""
        client = conn._http_client  # type: ignore[attr-defined]
        url = conn._http_url  # type: ignore[attr-defined]
        headers = conn._http_headers  # type: ignore[attr-defined]
        req_id = conn._next_id  # type: ignore[attr-defined]
        conn._next_id = req_id + 1  # type: ignore[attr-defined]

        resp = await client.post(url, headers=headers, json={
            "jsonrpc": "2.0",
            "id": req_id,
            "method": "tools/call",
            "params": {"name": tool_name, "arguments": arguments},
        }, timeout=300.0)

        ct = resp.headers.get("content-type", "")
        if "text/event-stream" in ct:
            data = self._parse_sse_json(resp.text)
        else:
            data = resp.json()

        if not data:
            return [{"type": "text", "text": "Empty response from MCP server"}]

        if "error" in data:
            return [{"type": "text", "text": f"MCP error: {data['error']}"}]

        result = data.get("result", {})
        content = result.get("content", [])
        return content if content else [{"type": "text", "text": json.dumps(result)}]

    @staticmethod
    def _format_mcp_result(result: Any) -> list[dict]:
        """Convert an MCP CallToolResult to content blocks."""
        if hasattr(result, "content"):
            blocks = []
            for item in result.content:
                if hasattr(item, "text"):
                    blocks.append({"type": "text", "text": item.text})
                elif hasattr(item, "data"):
                    blocks.append({
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": getattr(item, "mimeType", "image/png"),
                            "data": item.data,
                        },
                    })
                else:
                    blocks.append({"type": "text", "text": str(item)})
            return blocks if blocks else [{"type": "text", "text": "Done."}]

        return [{"type": "text", "text": str(result)}]

    def get_all_tool_schemas(self) -> list[ToolSchema]:
        """Return tool schemas from all connected MCP servers."""
        schemas = []
        for conn in self._connections.values():
            schemas.extend(conn.tools)
        return schemas

    def parse_mcp_tool_name(self, full_name: str) -> tuple[str, str] | None:
        """Parse mcp__<server>__<tool> into (server_name, tool_name).

        Returns None if the name doesn't match the MCP naming convention.
        """
        import re
        m = re.match(r"mcp__([^_]+(?:-[^_]+)*)__(.+)", full_name)
        if m:
            return m.group(1), m.group(2)
        return None

    async def disconnect_all(self):
        """Disconnect all MCP servers. Called on session end."""
        self._connections.clear()
        # The AsyncExitStack handles actual cleanup of transports/sessions
