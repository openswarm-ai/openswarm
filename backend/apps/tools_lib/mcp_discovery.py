import asyncio
import json
import logging
import os
import re
import shutil

import httpx
from fastapi import HTTPException

from backend.apps.tools_lib.mcp_config import _augmented_path, _resolve_command

logger = logging.getLogger(__name__)


def _parse_sse_json(text: str) -> dict | None:
    """Extract JSON from an SSE response body (handles `data: {...}` lines)."""
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


_NPX_CACHE_RE = re.compile(r"_npx[/\\]([0-9a-f]{8,})[/\\]")


def _try_heal_npx_cache(stderr: str) -> str | None:
    """On `ERR_MODULE_NOT_FOUND` pointing into `~/.npm/_npx/<hash>/`, wipe that one dir.

    Why: interrupted npx installs leave a `package-lock.json` in the cache dir so
    subsequent spawns reuse a partially-extracted node_modules tree, which dies at
    import time. Scoped strictly to the extracted hash subdir; never touches
    anything outside `~/.npm/_npx/`.
    """
    if "ERR_MODULE_NOT_FOUND" not in stderr:
        return None
    m = _NPX_CACHE_RE.search(stderr)
    if not m:
        return None
    hash_ = m.group(1)
    cache_dir = os.path.join(os.path.expanduser("~"), ".npm", "_npx", hash_)
    if not os.path.isdir(cache_dir):
        return None
    logger.warning("Corrupted npx cache detected at %s; wiping and letting caller retry", cache_dir)
    shutil.rmtree(cache_dir, ignore_errors=True)
    return hash_


async def _discover_mcp_tools_stdio(command: str, args: list[str] | None = None, env: dict | None = None, _attempt: int = 0) -> list[dict]:
    """Spawn a stdio MCP server process and call tools/list via JSON-RPC over stdin/stdout.

    On the first attempt, a failure that looks like corrupted npx cache
    (`ERR_MODULE_NOT_FOUND` pointing into `~/.npm/_npx/<hash>/`) triggers one
    auto-heal + retry. No heal on `_attempt >= 1`.
    """
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
        limit=10 * 1024 * 1024,  # 10 MB buffer for large tool lists
    )

    # Drain stderr in the background. Two reasons: (1) the OS pipe buffer is
    # ~64 KB; if npx prints more than that during a cold-cache install
    # (which happens when AV scanning slows npm), the child blocks on
    # write and we'd see what looks like a hang. (2) the rolling tail lets
    # us include npx's own diagnostic in any error we surface, instead of
    # the opaque "discovery failed" we used to show.
    stderr_tail: list[str] = []

    async def _drain_stderr() -> None:
        try:
            while True:
                chunk = await proc.stderr.readline()
                if not chunk:
                    return
                stderr_tail.append(chunk.decode(errors="replace"))
                if len(stderr_tail) > 50:
                    del stderr_tail[: len(stderr_tail) - 50]
        except asyncio.CancelledError:
            return
        except Exception:
            return

    stderr_task = asyncio.create_task(_drain_stderr())

    async def _send(msg: dict) -> None:
        line = json.dumps(msg) + "\n"
        proc.stdin.write(line.encode())
        await proc.stdin.drain()

    async def _recv(timeout_s: float = 30.0) -> dict:
        """Read JSON-RPC responses, skipping notification lines (no 'id' field)."""
        while True:
            line = await asyncio.wait_for(proc.stdout.readline(), timeout=timeout_s)
            if not line:
                # stdout EOF = child exited. Wait briefly for the stderr
                # drain to catch up so we capture the real failure reason
                # (which often arrives a few ms after stdout closes).
                try:
                    await asyncio.wait_for(asyncio.shield(stderr_task), timeout=1.0)
                except (asyncio.TimeoutError, asyncio.CancelledError, Exception):
                    pass
                tail = "".join(stderr_tail[-10:]).strip()
                raise HTTPException(
                    status_code=502,
                    detail=f"MCP stdio process exited unexpectedly{': ' + tail if tail else ''}",
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
        # First response is the slow one. On Windows with a cold npx cache,
        # `npx -y <pkg>` has to download the package + transitive deps and
        # AV-scan every file npm writes; total install time often exceeds
        # 60 s and occasionally pushes past 90 s. Subsequent reads run
        # against an already-running server and stay at the default 30 s.
        await _recv(timeout_s=120.0)

        await _send({"jsonrpc": "2.0", "method": "notifications/initialized"})

        await _send({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})
        data = await _recv()

        tools_list = data.get("result", {}).get("tools", [])
        return [{"name": t.get("name", ""), "description": t.get("description", ""), "inputSchema": t.get("inputSchema")} for t in tools_list]

    except HTTPException as e:
        # Heal-on-corrupt-npx-cache still triggers from the EOF branch,
        # which now includes the full stderr tail in `e.detail`; so the
        # ERR_MODULE_NOT_FOUND signature is still discoverable here.
        if _attempt == 0 and _try_heal_npx_cache(str(e.detail) if e.detail is not None else ""):
            return await _discover_mcp_tools_stdio(command, args, env, _attempt=1)
        raise
    except asyncio.TimeoutError:
        # Most common cause: cold npx cache on Windows. The npm install
        # persists across attempts, so a retry usually finishes against a
        # warm cache. Surface npx's own progress line if we have one; it
        # makes the cause obvious ("downloading X...") instead of opaque.
        tail_text = "".join(stderr_tail[-5:]).strip()
        detail = "MCP discovery timed out; the server may still be downloading on first run"
        if tail_text:
            preview = tail_text[-200:].replace("\n", " ").strip()
            detail += f" (last output: {preview})"
        detail += ". Try again in a moment."
        raise HTTPException(status_code=504, detail=detail)
    finally:
        stderr_task.cancel()
        try:
            await stderr_task
        except (asyncio.CancelledError, Exception):
            pass
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
