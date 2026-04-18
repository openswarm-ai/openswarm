import os

from backend.apps.tools.shared_utils.ToolDefinition import ToolDefinition
from backend.core.tools.shared_structs.MCP_Tool import STDIO_MCP_Tool
from backend.apps.tools.shared_utils.mcp_config import resolve_command, augmented_path
# TODO: either remove the import, or make them non private vars
from backend.config.paths import P_BACKEND_DIR, p_is_packaged
from swarm_debug import debug
from typeguard import typechecked


# TODO: better type specing of this whole func
@typechecked
def build_stdio_tool(
    tool_def: ToolDefinition,
    config: dict,
    server_name: str,
) -> STDIO_MCP_Tool:
    command = config.get("command", "")
    if command:
        resolved = resolve_command(command)
        if resolved:
            command = resolved
        else:
            debug(f"[build_stdio_tool] Command '{command}' not found on PATH or bundled directories")

    env = config.get("env", {})
    env.setdefault("PATH", augmented_path())
    env.setdefault("PYTHONPATH", "")

    if p_is_packaged:
        resources = os.path.dirname(os.path.dirname(P_BACKEND_DIR))
        bundled_python = os.path.join(resources, "python-env", "bin", "python3")
        if os.path.exists(bundled_python):
            env.setdefault("UV_PYTHON", bundled_python)
    else:
        venv_python = os.path.join(P_BACKEND_DIR, ".venv", "bin", "python3")
        if os.path.exists(venv_python):
            env.setdefault("UV_PYTHON", venv_python)

    return STDIO_MCP_Tool(
        name=tool_def.name,
        description=tool_def.description,
        deferred=False,
        permission="ask",
        server_name=server_name,
        command=command or None,
        args=config.get("args", []),
        env=env,
    )