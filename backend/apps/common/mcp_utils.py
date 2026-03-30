"""Shared MCP / SSE utilities used by tools_lib and mcp_client."""

from __future__ import annotations

import json
import re


def parse_sse_json(text: str) -> dict | None:
    """Extract JSON from an SSE response body (handles ``data: {...}`` lines)."""
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


def sanitize_server_name(name: str) -> str:
    """Convert a tool name into a valid MCP server identifier (alphanumeric + hyphens)."""
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
