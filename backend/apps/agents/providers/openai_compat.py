"""OpenAI-compatible provider adapter.

Works with ANY endpoint that speaks the OpenAI Chat Completions API:
OpenAI, OpenRouter, Together, Groq, Fireworks, Mistral, Ollama, vLLM, etc.
"""

from __future__ import annotations

import json
import logging
from typing import Any, AsyncIterator
from uuid import uuid4

from openai import AsyncOpenAI

from backend.apps.agents.providers.base import (
    BaseProvider, ContentBlock, ModelResponse, ProviderMessage,
    StreamEvent, ToolCall, ToolSchema,
)

logger = logging.getLogger(__name__)


class OpenAICompatProvider(BaseProvider):
    """Provider adapter for any OpenAI-compatible API endpoint."""

    def __init__(
        self,
        api_key: str = "",
        base_url: str | None = None,
    ):
        kwargs: dict[str, Any] = {}
        if api_key:
            kwargs["api_key"] = api_key
        if base_url:
            kwargs["base_url"] = base_url
        self.client = AsyncOpenAI(**kwargs)

    def get_model_id(self, short_name: str) -> str:
        # Pass through — user selects exact model ID
        return short_name

    def clean_tool_schema(self, schema: ToolSchema) -> dict:
        """Convert to OpenAI function calling format."""
        return {
            "type": "function",
            "function": {
                "name": schema.name,
                "description": schema.description,
                "parameters": schema.input_schema,
            },
        }

    def format_tool_result(self, tool_use_id: str, content: list[dict]) -> dict:
        """Format tool result as OpenAI expects."""
        # OpenAI wants a single string for tool results
        text_parts = []
        for block in content:
            if block.get("type") == "text":
                text_parts.append(block.get("text", ""))
            elif block.get("type") == "image":
                text_parts.append("[image]")
            else:
                text_parts.append(json.dumps(block))
        return {
            "role": "tool",
            "tool_call_id": tool_use_id,
            "content": "\n".join(text_parts) if text_parts else "Done.",
        }

    def format_user_message(self, content: Any) -> ProviderMessage:
        """Convert user content to OpenAI format."""
        if isinstance(content, str):
            return ProviderMessage(role="user", content=content)
        # Multimodal content (text + images)
        if isinstance(content, list):
            parts = []
            for block in content:
                if isinstance(block, dict):
                    if block.get("type") == "text":
                        parts.append({"type": "text", "text": block["text"]})
                    elif block.get("type") == "image":
                        source = block.get("source", {})
                        media_type = source.get("media_type", "image/png")
                        data = source.get("data", "")
                        parts.append({
                            "type": "image_url",
                            "image_url": {"url": f"data:{media_type};base64,{data}"},
                        })
                elif isinstance(block, str):
                    parts.append({"type": "text", "text": block})
            return ProviderMessage(role="user", content=parts)
        return ProviderMessage(role="user", content=str(content))

    def format_assistant_message(self, response: ModelResponse) -> ProviderMessage:
        """Convert ModelResponse to OpenAI assistant message format."""
        text_parts = []
        tool_calls = []
        for block in response.content:
            if block.type == "text":
                text_parts.append(block.text)
            elif block.type == "tool_use" and block.tool_call:
                tool_calls.append({
                    "id": block.tool_call.id,
                    "type": "function",
                    "function": {
                        "name": block.tool_call.name,
                        "arguments": json.dumps(block.tool_call.input),
                    },
                })
        msg: dict[str, Any] = {"role": "assistant"}
        if text_parts:
            msg["content"] = "\n".join(text_parts)
        else:
            msg["content"] = None
        if tool_calls:
            msg["tool_calls"] = tool_calls
        return ProviderMessage(role="assistant", content=msg)

    def _build_messages(
        self,
        system: str | None,
        messages: list[ProviderMessage],
    ) -> list[dict]:
        """Convert ProviderMessages to OpenAI API format."""
        result = []
        if system:
            result.append({"role": "system", "content": system})

        for msg in messages:
            if msg.role == "assistant":
                # Assistant messages are already in OpenAI format from format_assistant_message
                if isinstance(msg.content, dict) and "role" in msg.content:
                    result.append(msg.content)
                else:
                    # Raw content blocks from provider-agnostic format
                    text_parts = []
                    tool_calls = []
                    if isinstance(msg.content, list):
                        for block in msg.content:
                            if isinstance(block, dict):
                                if block.get("type") == "text":
                                    text_parts.append(block["text"])
                                elif block.get("type") == "tool_use":
                                    tool_calls.append({
                                        "id": block.get("id", uuid4().hex),
                                        "type": "function",
                                        "function": {
                                            "name": block.get("name", ""),
                                            "arguments": json.dumps(block.get("input", {})),
                                        },
                                    })
                    api_msg: dict[str, Any] = {
                        "role": "assistant",
                        "content": "\n".join(text_parts) if text_parts else None,
                    }
                    if tool_calls:
                        api_msg["tool_calls"] = tool_calls
                    result.append(api_msg)

            elif msg.role == "tool_result":
                # Tool results: content is a list of tool result dicts
                if isinstance(msg.content, list):
                    for tr in msg.content:
                        if isinstance(tr, dict) and "tool_call_id" in tr:
                            result.append(tr)
                elif isinstance(msg.content, dict) and "tool_call_id" in msg.content:
                    result.append(msg.content)

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
            "messages": self._build_messages(system, messages),
        }
        if tools:
            kwargs["tools"] = [self.clean_tool_schema(t) for t in tools]

        resp = await self.client.chat.completions.create(**kwargs)
        choice = resp.choices[0]
        message = choice.message

        content: list[ContentBlock] = []
        if message.content:
            content.append(ContentBlock(type="text", text=message.content))

        if message.tool_calls:
            for tc in message.tool_calls:
                try:
                    args = json.loads(tc.function.arguments)
                except json.JSONDecodeError:
                    args = {}
                content.append(ContentBlock(
                    type="tool_use",
                    tool_call=ToolCall(
                        id=tc.id,
                        name=tc.function.name,
                        input=args,
                    ),
                ))

        stop = "end_turn"
        if choice.finish_reason == "tool_calls":
            stop = "tool_use"
        elif message.tool_calls:
            stop = "tool_use"

        usage_dict = {}
        if resp.usage:
            usage_dict = {
                "input_tokens": resp.usage.prompt_tokens,
                "output_tokens": resp.usage.completion_tokens,
            }

        return ModelResponse(content=content, stop_reason=stop, usage=usage_dict)

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
            "messages": self._build_messages(system, messages),
            "stream": True,
            "stream_options": {"include_usage": True},
        }
        if tools:
            kwargs["tools"] = [self.clean_tool_schema(t) for t in tools]

        stream = await self.client.chat.completions.create(**kwargs)

        # Track streaming state to emit normalized events
        text_started = False
        text_index = 0
        tool_indices: dict[int, dict] = {}  # openai tool_call index -> {name, id, json_buf}
        next_block_index = 0

        async for chunk in stream:
            if not chunk.choices:
                # Usage-only chunk at the end
                if chunk.usage:
                    yield StreamEvent(type="usage", usage={
                        "input_tokens": chunk.usage.prompt_tokens or 0,
                        "output_tokens": chunk.usage.completion_tokens or 0,
                    })
                continue

            delta = chunk.choices[0].delta
            finish_reason = chunk.choices[0].finish_reason

            # Text content
            if delta.content is not None:
                if not text_started:
                    text_started = True
                    text_index = next_block_index
                    next_block_index += 1
                    yield StreamEvent(
                        type="content_block_start",
                        index=text_index,
                        block_type="text",
                    )
                yield StreamEvent(
                    type="content_block_delta",
                    index=text_index,
                    delta_type="text_delta",
                    text=delta.content,
                )

            # Tool calls
            if delta.tool_calls:
                for tc_delta in delta.tool_calls:
                    tc_idx = tc_delta.index
                    if tc_idx not in tool_indices:
                        # New tool call starting
                        if text_started:
                            yield StreamEvent(type="content_block_stop", index=text_index)
                            text_started = False

                        block_idx = next_block_index
                        next_block_index += 1
                        tool_indices[tc_idx] = {
                            "block_index": block_idx,
                            "id": tc_delta.id or uuid4().hex,
                            "name": tc_delta.function.name if tc_delta.function else "",
                            "json_buf": "",
                        }
                        yield StreamEvent(
                            type="content_block_start",
                            index=block_idx,
                            block_type="tool_use",
                            tool_name=tool_indices[tc_idx]["name"],
                            tool_id=tool_indices[tc_idx]["id"],
                        )

                    info = tool_indices[tc_idx]
                    if tc_delta.function and tc_delta.function.name:
                        info["name"] = tc_delta.function.name
                    if tc_delta.function and tc_delta.function.arguments:
                        info["json_buf"] += tc_delta.function.arguments
                        yield StreamEvent(
                            type="content_block_delta",
                            index=info["block_index"],
                            delta_type="input_json_delta",
                            text=tc_delta.function.arguments,
                        )

            # Finish
            if finish_reason is not None:
                if text_started:
                    yield StreamEvent(type="content_block_stop", index=text_index)
                for info in tool_indices.values():
                    yield StreamEvent(type="content_block_stop", index=info["block_index"])
                yield StreamEvent(type="message_stop")
