"""Central tool registry.

Importing this module automatically registers all builtin tools.
"""

from __future__ import annotations

from backend.apps.agents.tools.base import BaseTool
from backend.apps.agents.providers.base import ToolSchema

_TOOLS: dict[str, BaseTool] = {}


def register_tool(tool: BaseTool) -> None:
    """Register a tool instance by its name."""
    _TOOLS[tool.name] = tool


def get_tool(name: str) -> BaseTool | None:
    """Look up a registered tool by name. Returns None if not found."""
    return _TOOLS.get(name)


def get_all_tools() -> list[BaseTool]:
    """Return all registered tool instances."""
    return list(_TOOLS.values())


def get_all_tool_schemas() -> list[ToolSchema]:
    """Return provider-agnostic ToolSchema for every registered tool."""
    return [t.to_tool_schema() for t in _TOOLS.values()]


def init_tools() -> None:
    """Import and register all builtin tools."""
    from backend.apps.agents.tools.filesystem import (
        ReadTool,
        WriteTool,
        EditTool,
        GlobTool,
        GrepTool,
    )
    from backend.apps.agents.tools.system import BashTool, AskUserQuestionTool
    from backend.apps.agents.tools.web import WebSearchTool, WebFetchTool

    for tool_cls in [
        ReadTool,
        WriteTool,
        EditTool,
        GlobTool,
        GrepTool,
        BashTool,
        AskUserQuestionTool,
        WebSearchTool,
        WebFetchTool,
    ]:
        register_tool(tool_cls())


# Auto-register on import
init_tools()
