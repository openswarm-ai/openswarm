"""Base classes for builtin tool implementations."""

from abc import ABC, abstractmethod
from dataclasses import dataclass


@dataclass
class ToolContext:
    cwd: str
    session_id: str


class BaseTool(ABC):
    name: str
    description: str

    @abstractmethod
    def get_schema(self) -> dict:
        ...

    @abstractmethod
    async def execute(self, input_data: dict, context: ToolContext) -> list[dict]:
        ...
