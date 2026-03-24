"""Anthropic provider adapter using the native Anthropic SDK."""

from __future__ import annotations

import json
import logging
from typing import Any, AsyncIterator

import anthropic

from backend.apps.agents.providers.base import (
    BaseProvider, ContentBlock, ModelResponse, ProviderMessage,
    StreamEvent, ToolCall, ToolSchema,
)

logger = logging.getLogger(__name__)

MODEL_MAP = {
    "sonnet": "claude-sonnet-4-6",
    "opus": "claude-opus-4-6",
    "haiku": "claude-haiku-4-5",
}


class AnthropicProvider(BaseProvider):
    """Provider adapter for Anthropic's Messages API."""

    def __init__(
        self,
        api_key: str | None = None,
        auth_token: str | None = None,
        base_url: str | None = None,
    ):
        kwargs: dict[str, Any] = {}
        if auth_token:
            kwargs["auth_token"] = auth_token
        elif api_key:
            kwargs["api_key"] = api_key
        if base_url:
            kwargs["base_url"] = base_url
        self.client = anthropic.AsyncAnthropic(**kwargs)

    def get_model_id(self, short_name: str) -> str:
        return MODEL_MAP.get(short_name, short_name)

    def clean_tool_schema(self, schema: ToolSchema) -> dict:
        return {
            "name": schema.name,
            "description": schema.description,
            "input_schema": schema.input_schema,
        }

    def format_tool_result(self, tool_use_id: str, content: list[dict]) -> dict:
        return {
            "type": "tool_result",
            "tool_use_id": tool_use_id,
            "content": content,
        }

    def format_user_message(self, content: Any) -> ProviderMessage:
        return ProviderMessage(role="user", content=content)

    def format_assistant_message(self, response: ModelResponse) -> ProviderMessage:
        blocks = []
        for block in response.content:
            if block.type == "text":
                blocks.append({"type": "text", "text": block.text})
            elif block.type == "tool_use" and block.tool_call:
                blocks.append({
                    "type": "tool_use",
                    "id": block.tool_call.id,
                    "name": block.tool_call.name,
                    "input": block.tool_call.input,
                })
        return ProviderMessage(role="assistant", content=blocks)

    def _build_messages(self, messages: list[ProviderMessage]) -> list[dict]:
        """Convert ProviderMessages to Anthropic API format."""
        result = []
        for msg in messages:
            if msg.role == "tool_result":
                # Tool results: content is a list of tool_result dicts
                if isinstance(msg.content, list):
                    result.append({"role": "user", "content": msg.content})
                else:
                    result.append({"role": "user", "content": [msg.content]})
            elif msg.role == "assistant":
                result.append({"role": "assistant", "content": msg.content})
            elif msg.role == "user":
                result.append({"role": "user", "content": msg.content})
        return result

    async def create_message(
        self,
        model: str,
        system: str | None,
        messages: list[ProviderMessage],
        tools: list[ToolSchema],
        max_tokens: int = 8192,
    ) -> ModelResponse:
        kwargs: dict[str, Any] = {
            "model": self.get_model_id(model),
            "max_tokens": max_tokens,
            "messages": self._build_messages(messages),
        }
        if system:
            kwargs["system"] = system
        if tools:
            kwargs["tools"] = [self.clean_tool_schema(t) for t in tools]

        resp = await self.client.messages.create(**kwargs)

        content = []
        for block in resp.content:
            if block.type == "text":
                content.append(ContentBlock(type="text", text=block.text))
            elif block.type == "tool_use":
                content.append(ContentBlock(
                    type="tool_use",
                    tool_call=ToolCall(
                        id=block.id,
                        name=block.name,
                        input=block.input,
                    ),
                ))

        return ModelResponse(
            content=content,
            stop_reason="tool_use" if resp.stop_reason == "tool_use" else "end_turn",
            usage={
                "input_tokens": resp.usage.input_tokens,
                "output_tokens": resp.usage.output_tokens,
            },
        )

    async def stream_message(
        self,
        model: str,
        system: str | None,
        messages: list[ProviderMessage],
        tools: list[ToolSchema],
        max_tokens: int = 8192,
    ) -> AsyncIterator[StreamEvent]:
        kwargs: dict[str, Any] = {
            "model": self.get_model_id(model),
            "max_tokens": max_tokens,
            "messages": self._build_messages(messages),
        }
        if system:
            kwargs["system"] = system
        if tools:
            kwargs["tools"] = [self.clean_tool_schema(t) for t in tools]

        # Use create() with stream=True for raw SSE events
        kwargs["stream"] = True
        raw_stream = await self.client.messages.create(**kwargs)

        current_block_type: dict[int, str] = {}
        current_tool_name: dict[int, str] = {}
        current_tool_id: dict[int, str] = {}
        current_text: dict[int, str] = {}
        current_json: dict[int, str] = {}

        async for event in raw_stream:
            event_type = getattr(event, "type", "")

            if event_type == "content_block_start":
                index = event.index
                block = event.content_block
                block_type = block.type
                current_block_type[index] = block_type

                if block_type == "text":
                    current_text[index] = ""
                    yield StreamEvent(
                        type="content_block_start",
                        index=index,
                        block_type="text",
                    )
                elif block_type == "tool_use":
                    current_tool_name[index] = block.name
                    current_tool_id[index] = block.id
                    current_json[index] = ""
                    yield StreamEvent(
                        type="content_block_start",
                        index=index,
                        block_type="tool_use",
                        tool_name=block.name,
                        tool_id=block.id,
                    )

            elif event_type == "content_block_delta":
                index = event.index
                delta = event.delta
                delta_type = delta.type

                if delta_type == "text_delta":
                    current_text.setdefault(index, "")
                    current_text[index] += delta.text
                    yield StreamEvent(
                        type="content_block_delta",
                        index=index,
                        delta_type="text_delta",
                        text=delta.text,
                    )
                elif delta_type == "input_json_delta":
                    current_json.setdefault(index, "")
                    current_json[index] += delta.partial_json
                    yield StreamEvent(
                        type="content_block_delta",
                        index=index,
                        delta_type="input_json_delta",
                        text=delta.partial_json,
                    )

            elif event_type == "content_block_stop":
                yield StreamEvent(type="content_block_stop", index=event.index)

            elif event_type == "message_delta":
                # Extract output token usage from the final delta
                usage_data = {}
                delta_usage = getattr(event, "usage", None)
                if delta_usage:
                    output_tokens = getattr(delta_usage, "output_tokens", 0)
                    if output_tokens:
                        usage_data["output_tokens"] = output_tokens
                if usage_data:
                    yield StreamEvent(type="usage", usage=usage_data)

            elif event_type == "message_start":
                # Extract input token usage from the message start
                msg = getattr(event, "message", None)
                if msg:
                    msg_usage = getattr(msg, "usage", None)
                    if msg_usage:
                        usage_data = {}
                        input_tokens = getattr(msg_usage, "input_tokens", 0)
                        output_tokens = getattr(msg_usage, "output_tokens", 0)
                        if input_tokens:
                            usage_data["input_tokens"] = input_tokens
                        if output_tokens:
                            usage_data["output_tokens"] = output_tokens
                        if usage_data:
                            yield StreamEvent(type="usage", usage=usage_data)

        yield StreamEvent(type="message_stop")

    async def stream_and_collect(
        self,
        model: str,
        system: str | None,
        messages: list[ProviderMessage],
        tools: list[ToolSchema],
        max_tokens: int = 8192,
    ) -> tuple[AsyncIterator[StreamEvent], ModelResponse]:
        """Helper: stream events and also return the full collected response.

        Not used directly — the AgentLoop handles collection.
        """
        raise NotImplementedError("Use stream_message() directly; AgentLoop collects.")
