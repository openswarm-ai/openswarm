"""Owned agent loop — replaces claude_agent_sdk's query() function.

Generalizes the pattern from browser_agent.py (lines 243-334) into a
provider-agnostic, streaming, HITL-aware tool-use loop.
"""

from __future__ import annotations

import json
import logging
import time
from typing import Any, Callable, Awaitable
from uuid import uuid4

from backend.apps.agents.providers.base import (
    BaseProvider, ContentBlock, ModelResponse, ProviderMessage,
    StreamEvent, ToolCall, ToolSchema,
)

logger = logging.getLogger(__name__)

# Type aliases for callbacks
ToolExecutor = Callable[[str, dict], Awaitable[list[dict]]]
# hitl_handler(tool_name, tool_input) -> (approved, updated_input_or_None)
HITLHandler = Callable[[str, dict], Awaitable[tuple[bool, dict | None]]]
# ws_emitter(event_type, data) -> None
WSEmitter = Callable[[str, dict], Awaitable[None]]


class AgentLoop:
    """Provider-agnostic agent loop with streaming and HITL support.

    The loop:
    1. Sends user message to the model
    2. Streams the response (emitting WebSocket events)
    3. If the model requests tool use:
       a. For each tool call: check HITL permission → execute → collect result
       b. Append tool results → go to step 2
    4. If the model stops (end_turn/max_tokens): done
    """

    def __init__(
        self,
        session_id: str,
        provider: BaseProvider,
        model: str,
        system_prompt: str | None,
        tools: list[ToolSchema],
        tool_executor: ToolExecutor,
        hitl_handler: HITLHandler,
        ws_emitter: WSEmitter,
        max_turns: int | None = None,
        cwd: str | None = None,
    ):
        self.session_id = session_id
        self.provider = provider
        self.model = model
        self.system_prompt = system_prompt
        self.tools = tools
        self.tool_executor = tool_executor
        self.hitl_handler = hitl_handler
        self.ws_emitter = ws_emitter
        self.max_turns = max_turns
        self.cwd = cwd

        # Conversation history in provider-agnostic format
        self.messages: list[ProviderMessage] = []

        # Token tracking
        self.total_input_tokens = 0
        self.total_output_tokens = 0

    async def run(self, user_content: Any) -> None:
        """Run the agent loop for a single user turn."""
        # Append user message
        user_msg = self.provider.format_user_message(user_content)
        self.messages.append(user_msg)

        turn = 0
        while True:
            if self.max_turns and turn >= self.max_turns:
                logger.info(f"Agent {self.session_id}: max turns ({self.max_turns}) reached")
                break
            turn += 1

            # Stream the model response and collect it
            response = await self._stream_and_collect()

            # Track usage
            self.total_input_tokens += response.usage.get("input_tokens", 0)
            self.total_output_tokens += response.usage.get("output_tokens", 0)

            # Append assistant message to conversation history
            assistant_msg = self.provider.format_assistant_message(response)
            self.messages.append(assistant_msg)

            # If no tool use, we're done
            if response.stop_reason != "tool_use":
                break

            # Execute tools
            tool_results = await self._execute_tools(response)
            if not tool_results:
                break

            # Append tool results
            self.messages.append(ProviderMessage(role="tool_result", content=tool_results))

    async def _stream_and_collect(self) -> ModelResponse:
        """Stream model output, emit WebSocket events, collect full response."""
        collected_content: list[ContentBlock] = []
        collected_usage: dict[str, int] = {}
        stop_reason = "end_turn"

        # Track streaming state for WS emissions
        stream_text_msg_id: str | None = None
        stream_tool_msg_ids: dict[int, str] = {}  # block index -> msg_id
        block_index_map: dict[int, str] = {}  # block index -> msg_id

        # Buffers for collecting content
        text_buffers: dict[int, str] = {}
        json_buffers: dict[int, str] = {}
        tool_names: dict[int, str] = {}
        tool_ids: dict[int, str] = {}
        block_types: dict[int, str] = {}

        async for event in self.provider.stream_message(
            model=self.model,
            system=self.system_prompt,
            messages=self.messages,
            tools=self.tools,
        ):
            if event.type == "content_block_start":
                if event.block_type == "text":
                    if stream_text_msg_id is None:
                        stream_text_msg_id = uuid4().hex
                        await self.ws_emitter("agent:stream_start", {
                            "message_id": stream_text_msg_id,
                            "role": "assistant",
                        })
                    block_index_map[event.index] = stream_text_msg_id
                    block_types[event.index] = "text"
                    text_buffers[event.index] = ""

                elif event.block_type == "tool_use":
                    tool_msg_id = uuid4().hex
                    stream_tool_msg_ids[event.index] = tool_msg_id
                    block_index_map[event.index] = tool_msg_id
                    block_types[event.index] = "tool_use"
                    tool_names[event.index] = event.tool_name
                    tool_ids[event.index] = event.tool_id
                    json_buffers[event.index] = ""

                    await self.ws_emitter("agent:stream_start", {
                        "message_id": tool_msg_id,
                        "role": "tool_call",
                        "tool_name": event.tool_name,
                    })

            elif event.type == "content_block_delta":
                msg_id = block_index_map.get(event.index)
                if not msg_id:
                    continue

                if event.delta_type == "text_delta":
                    text_buffers.setdefault(event.index, "")
                    text_buffers[event.index] += event.text
                    await self.ws_emitter("agent:stream_delta", {
                        "message_id": msg_id,
                        "delta": event.text,
                    })

                elif event.delta_type == "input_json_delta":
                    json_buffers.setdefault(event.index, "")
                    json_buffers[event.index] += event.text
                    await self.ws_emitter("agent:stream_delta", {
                        "message_id": msg_id,
                        "delta": event.text,
                    })

            elif event.type == "content_block_stop":
                msg_id = block_index_map.get(event.index)
                bt = block_types.get(event.index, "")

                if bt == "text":
                    collected_content.append(
                        ContentBlock(type="text", text=text_buffers.get(event.index, ""))
                    )
                elif bt == "tool_use":
                    try:
                        tool_input = json.loads(json_buffers.get(event.index, "{}"))
                    except json.JSONDecodeError:
                        tool_input = {}
                    collected_content.append(ContentBlock(
                        type="tool_use",
                        tool_call=ToolCall(
                            id=tool_ids.get(event.index, uuid4().hex),
                            name=tool_names.get(event.index, ""),
                            input=tool_input,
                        ),
                    ))

                # Send stream_end for tool blocks (text block ends at message_stop)
                if msg_id and bt == "tool_use":
                    await self.ws_emitter("agent:stream_end", {
                        "message_id": msg_id,
                    })

            elif event.type == "usage":
                # Accumulate token usage from provider stream
                for k, v in event.usage.items():
                    collected_usage[k] = collected_usage.get(k, 0) + v

            elif event.type == "message_stop":
                # Check if any tool calls means stop_reason is tool_use
                has_tool_use = any(b.type == "tool_use" for b in collected_content)
                if has_tool_use:
                    stop_reason = "tool_use"

                # End text stream
                if stream_text_msg_id:
                    await self.ws_emitter("agent:stream_end", {
                        "message_id": stream_text_msg_id,
                    })

        # Build and emit the collected messages
        await self._emit_collected_messages(
            collected_content, stream_text_msg_id, stream_tool_msg_ids,
        )

        return ModelResponse(
            content=collected_content,
            stop_reason=stop_reason,
            usage=collected_usage,
        )

    async def _emit_collected_messages(
        self,
        content: list[ContentBlock],
        text_msg_id: str | None,
        tool_msg_ids: dict[int, str],
    ) -> None:
        """Emit finalized agent:message events for the collected response."""
        from backend.apps.agents.models import Message

        # Emit text message
        text_parts = [b.text for b in content if b.type == "text" and b.text]
        if text_parts:
            msg = Message(
                id=text_msg_id or uuid4().hex,
                role="assistant",
                content="\n".join(text_parts),
            )
            await self.ws_emitter("agent:message", {
                "message": msg.model_dump(mode="json"),
            })

        # Emit tool call messages
        tool_blocks = [b for b in content if b.type == "tool_use" and b.tool_call]
        tool_id_list = sorted(tool_msg_ids.items(), key=lambda x: x[0])
        for i, block in enumerate(tool_blocks):
            tc = block.tool_call
            msg_id = tool_id_list[i][1] if i < len(tool_id_list) else uuid4().hex
            msg = Message(
                id=msg_id,
                role="tool_call",
                content={
                    "id": tc.id,
                    "tool": tc.name,
                    "input": tc.input,
                },
            )
            await self.ws_emitter("agent:message", {
                "message": msg.model_dump(mode="json"),
            })

    async def _execute_tools(self, response: ModelResponse) -> list[dict]:
        """Execute all tool calls from a response, respecting HITL permissions.

        Returns a list of tool result dicts formatted for the provider.
        """
        from backend.apps.agents.models import Message

        results = []
        for block in response.content:
            if block.type != "tool_use" or not block.tool_call:
                continue

            tc = block.tool_call
            start_time = time.time()

            # HITL permission check
            approved, updated_input = await self.hitl_handler(tc.name, tc.input)

            if not approved:
                result_content = [{"type": "text", "text": "Tool use was denied by the user."}]
            else:
                tool_input = updated_input if updated_input else tc.input
                try:
                    result_content = await self.tool_executor(tc.name, tool_input)
                except Exception as e:
                    logger.warning(f"Tool execution error: {tc.name}: {e}")
                    result_content = [{"type": "text", "text": f"Error executing {tc.name}: {e}"}]

            elapsed_ms = int((time.time() - start_time) * 1000)

            # Emit tool result to frontend
            result_text = ""
            for block_item in result_content:
                if isinstance(block_item, dict) and block_item.get("type") == "text":
                    result_text = block_item.get("text", "")
                    break

            result_msg = Message(
                role="tool_result",
                content={
                    "text": result_text[:15000] if result_text else "Done.",
                    "tool_name": tc.name,
                    "elapsed_ms": elapsed_ms,
                },
            )
            await self.ws_emitter("agent:message", {
                "message": result_msg.model_dump(mode="json"),
            })

            # Format for provider
            results.append(
                self.provider.format_tool_result(tc.id, result_content)
            )

        return results
