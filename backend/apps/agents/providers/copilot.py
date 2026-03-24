"""GitHub Copilot provider — routes through Copilot's OpenAI-compatible API.

Uses the user's GitHub Copilot subscription to access Claude, GPT, and other models.
Extends OpenAICompatProvider since Copilot's API speaks the OpenAI format.
"""

from __future__ import annotations

import logging
import time
from typing import Any, AsyncIterator

from openai import AsyncOpenAI

from backend.apps.agents.providers.base import (
    BaseProvider, ProviderMessage, StreamEvent, ToolSchema, ModelResponse,
)
from backend.apps.agents.providers.openai_compat import OpenAICompatProvider

logger = logging.getLogger(__name__)

COPILOT_API_BASE = "https://api.githubcopilot.com"


class CopilotProvider(OpenAICompatProvider):
    """Provider that routes through GitHub Copilot's API."""

    def __init__(self, copilot_token: str):
        # Initialize OpenAI client pointing at Copilot's API
        self.client = AsyncOpenAI(
            api_key=copilot_token,
            base_url=COPILOT_API_BASE,
        )
        # Store token for header injection
        self._copilot_token = copilot_token

    def get_model_id(self, short_name: str) -> str:
        # Copilot uses same model IDs — pass through
        return short_name

    async def stream_message(
        self,
        model: str,
        system: str | None,
        messages: list[ProviderMessage],
        tools: list[ToolSchema],
        max_tokens: int = 8192,
    ) -> AsyncIterator[StreamEvent]:
        """Stream with Copilot-specific headers."""
        kwargs: dict[str, Any] = {
            "model": self.get_model_id(model),
            "max_tokens": max_tokens,
            "messages": self._build_messages(system, messages),
            "stream": True,
            "extra_headers": {
                "copilot-integration-id": "vscode-chat",
            },
        }
        if tools:
            kwargs["tools"] = [self.clean_tool_schema(t) for t in tools]

        stream = await self.client.chat.completions.create(**kwargs)

        # Reuse parent's stream parsing logic
        text_started = False
        text_index = 0
        tool_indices: dict[int, dict] = {}
        next_block_index = 0

        from uuid import uuid4

        async for chunk in stream:
            if not chunk.choices:
                continue

            delta = chunk.choices[0].delta
            finish_reason = chunk.choices[0].finish_reason

            if delta.content is not None:
                if not text_started:
                    text_started = True
                    text_index = next_block_index
                    next_block_index += 1
                    yield StreamEvent(type="content_block_start", index=text_index, block_type="text")
                yield StreamEvent(type="content_block_delta", index=text_index, delta_type="text_delta", text=delta.content)

            if delta.tool_calls:
                for tc_delta in delta.tool_calls:
                    tc_idx = tc_delta.index
                    if tc_idx not in tool_indices:
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
                            type="content_block_start", index=block_idx, block_type="tool_use",
                            tool_name=tool_indices[tc_idx]["name"], tool_id=tool_indices[tc_idx]["id"],
                        )
                    info = tool_indices[tc_idx]
                    if tc_delta.function and tc_delta.function.name:
                        info["name"] = tc_delta.function.name
                    if tc_delta.function and tc_delta.function.arguments:
                        info["json_buf"] += tc_delta.function.arguments
                        yield StreamEvent(
                            type="content_block_delta", index=info["block_index"],
                            delta_type="input_json_delta", text=tc_delta.function.arguments,
                        )

            if finish_reason is not None:
                if text_started:
                    yield StreamEvent(type="content_block_stop", index=text_index)
                for info in tool_indices.values():
                    yield StreamEvent(type="content_block_stop", index=info["block_index"])
                yield StreamEvent(type="message_stop")
