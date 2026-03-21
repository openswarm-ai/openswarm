"""Base classes for builtin tool implementations."""

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any


@dataclass
class ToolContext:
    """Runtime context passed to every tool execution."""
    cwd: str
    session_id: str


class BaseTool(ABC):
    """Abstract base for all builtin tools.

    Subclasses must set ``name`` and ``description`` as class attributes and
    implement ``get_schema`` (JSON Schema for tool input) and ``execute``.
    """

    name: str
    description: str

    @abstractmethod
    def get_schema(self) -> dict:
        """Return JSON Schema for this tool's input parameters."""
        ...

    @abstractmethod
    async def execute(self, input_data: dict, context: ToolContext) -> list[dict]:
        """Execute the tool.

        Returns a list of content blocks, e.g.
        ``[{"type": "text", "text": "..."}]``.
        """
        ...

    def to_tool_schema(self):
        """Convert to the provider-agnostic ``ToolSchema`` used everywhere."""
        from backend.apps.agents.providers.base import ToolSchema

        return ToolSchema(
            name=self.name,
            description=self.description,
            input_schema=self.get_schema(),
        )
