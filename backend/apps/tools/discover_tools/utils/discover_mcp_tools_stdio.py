import asyncio
import json
import os

from backend.apps.tools.shared_utils.mcp_config import resolve_command, augmented_path
from backend.apps.tools.discover_tools.DiscoveryError import DiscoveryError, DiscoveryConfigError
from typeguard import typechecked

# TODO: better type specing of this whole func
@typechecked
async def discover_mcp_tools_stdio(
    command: str,
    args: list[str] | None = None,
    env: dict | None = None,
) -> list[dict]:
    """Discover tools by spawning an MCP server subprocess via stdio."""
    cmd_path = resolve_command(command)
    if not cmd_path:
        raise DiscoveryConfigError(f"Command '{command}' not found on PATH or common install locations")

    proc_env = {**os.environ, **(env or {}), "PATH": augmented_path()}
    proc_env.pop("PYTHONPATH", None)

    proc = await asyncio.create_subprocess_exec(
        cmd_path, *(args or []),
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=proc_env,
        limit=1024 * 1024,
    )

    async def _send(msg: dict) -> None:
        assert proc.stdin is not None
        line = json.dumps(msg) + "\n"
        proc.stdin.write(line.encode())
        await proc.stdin.drain()

    async def _recv() -> dict:
        assert proc.stdout is not None and proc.stderr is not None
        while True:
            line = await asyncio.wait_for(proc.stdout.readline(), timeout=30.0)
            if not line:
                stderr_out = ""
                try:
                    stderr_out = (await asyncio.wait_for(proc.stderr.read(4096), timeout=2.0)).decode(errors="replace")
                except (asyncio.TimeoutError, Exception):
                    pass
                raise DiscoveryError(
                    f"MCP stdio process exited unexpectedly{': ' + stderr_out if stderr_out else ''}"
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
                "clientInfo": {"name": "openswarm", "version": "0.1.0"},
            },
        })
        await _recv()
        await _send({"jsonrpc": "2.0", "method": "notifications/initialized"})
        await _send({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})
        data = await _recv()
        tools_list = data.get("result", {}).get("tools", [])
        return [
            {"name": t.get("name", ""), "description": t.get("description", ""), "inputSchema": t.get("inputSchema")}
            for t in tools_list
        ]
    except (DiscoveryError, DiscoveryConfigError):
        raise
    except asyncio.TimeoutError:
        raise DiscoveryError("MCP stdio server timed out during discovery")
    finally:
        try:
            if proc.stdin:
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
