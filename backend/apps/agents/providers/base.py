"""Provider-agnostic base classes for multi-model support.

All provider adapters (Anthropic, OpenAI, Gemini, OpenAI-compatible)
implement BaseProvider, translating their native APIs into these
common data structures.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, AsyncIterator


@dataclass
class ToolSchema:
    """Provider-agnostic tool definition."""
    name: str
    description: str
    input_schema: dict[str, Any]


@dataclass
class ToolCall:
    """A tool invocation requested by the model."""
    id: str
    name: str
    input: dict[str, Any]


@dataclass
class ContentBlock:
    """A block of content from the model response."""
    type: str  # "text" | "tool_use"
    text: str = ""
    tool_call: ToolCall | None = None


@dataclass
class ModelResponse:
    """Complete (non-streaming) response from a provider."""
    content: list[ContentBlock]
    stop_reason: str  # "end_turn" | "tool_use" | "max_tokens"
    usage: dict[str, int] = field(default_factory=dict)


@dataclass
class StreamEvent:
    """A single streaming event, normalized across providers.

    The event types match what the frontend already expects via WebSocket:
    content_block_start, content_block_delta, content_block_stop, message_stop.
    """
    type: str
    index: int = 0
    block_type: str = ""    # "text" | "tool_use"
    delta_type: str = ""    # "text_delta" | "input_json_delta"
    text: str = ""
    tool_name: str = ""
    tool_id: str = ""
    usage: dict[str, int] = field(default_factory=dict)


@dataclass
class ProviderMessage:
    """Provider-agnostic message for conversation history.

    Each provider adapter converts these to/from its native format.
    """
    role: str  # "user" | "assistant" | "tool_result"
    content: Any  # str, list[dict], or provider-specific content


class BaseProvider(ABC):
    """Abstract base for LLM provider adapters."""

    @abstractmethod
    async def stream_message(
        self,
        model: str,
        system: str | None,
        messages: list[ProviderMessage],
        tools: list[ToolSchema],
        max_tokens: int = 8192,
    ) -> AsyncIterator[StreamEvent]:
        """Stream a model response, yielding normalized StreamEvents."""
        ...

    @abstractmethod
    async def create_message(
        self,
        model: str,
        system: str | None,
        messages: list[ProviderMessage],
        tools: list[ToolSchema],
        max_tokens: int = 8192,
    ) -> ModelResponse:
        """Non-streaming message creation."""
        ...

    @abstractmethod
    def format_tool_result(
        self,
        tool_use_id: str,
        content: list[dict],
    ) -> dict:
        """Format a tool result in this provider's expected message format."""
        ...

    @abstractmethod
    def format_user_message(self, content: Any) -> ProviderMessage:
        """Wrap user content (str or multimodal blocks) into a ProviderMessage."""
        ...

    @abstractmethod
    def format_assistant_message(self, response: ModelResponse) -> ProviderMessage:
        """Convert a ModelResponse into a ProviderMessage for conversation history."""
        ...

    @abstractmethod
    def get_model_id(self, short_name: str) -> str:
        """Resolve a short model name to the full API model ID."""
        ...

    def clean_tool_schema(self, schema: ToolSchema) -> dict:
        """Convert a ToolSchema to the provider's native tool format.

        Default: Anthropic-style format. Override for providers that need
        different formats or schema cleaning (e.g. Gemini).
        """
        return {
            "name": schema.name,
            "description": schema.description,
            "input_schema": schema.input_schema,
        }
