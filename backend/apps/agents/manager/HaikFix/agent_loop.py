"""Main agent loop — orchestrates the Claude Agent SDK query loop.

Heavy logic is delegated to sibling modules:
- agent_mock       – mock-agent fallback, streaming helpers, session analytics
- agent_hooks      – SDK hook factories (approval, permissions, post-tool)
- agent_options    – MCP server construction & ClaudeAgentOptions building
"""

from __future__ import annotations

import asyncio
import logging
from uuid import uuid4

from typeguard import typechecked

from backend.apps.agents.models import AgentSession, Message
from backend.apps.agents.manager.ws_manager import ws_manager
from backend.apps.agents.manager.session_store import save_session
from backend.apps.agents.execution.prompt_builder import build_prompt_content
from backend.apps.tools_lib.tools_lib import (
    _load_all as load_all_tools,
    load_builtin_permissions,
)
from backend.apps.analytics.collector import record as _analytics
from backend.apps.agents.execution.agent_hooks import create_sdk_hooks

from claude_agent_sdk import (
    query, ClaudeAgentOptions, AssistantMessage, ResultMessage,
)
from claude_agent_sdk.types import (
    PermissionResultAllow, PermissionResultDeny,
    TextBlock, ToolUseBlock, StreamEvent, SystemMessage,
)
from backend.apps.agents.execution.agent_options import build_agent_options

from backend.apps.agents.manager.HaikFix.PromptChunks import ImageChunk, ImageChunkDict, TextChunk, TextChunkDict
from typing import List, Dict, Literal, Any, Union, Optional

logger = logging.getLogger(__name__)


@typechecked
def build_image_prompt_content(prompt: str, images: List[ImageChunk]) -> List[TextChunk | ImageChunk]:
    content: List[Union[ImageChunkDict, TextChunkDict]] = [TextChunk(text=prompt).to_dict()]
    for img in images:
        content.append(img.to_dict())
    return content


PromptMsgDict = Dict[
    Literal["type", "message"], 
    Dict[
        Literal["role", "content"], 
        List[
            Union[ImageChunkDict, TextChunkDict]
            ]
        ]
    ]

@typechecked
def build_prompt_msg(prompt: str, images: Optional[List[ImageChunk]]) -> PromptMsgDict:
    content = build_image_prompt_content(prompt, images)
    return {
        "type": "user", 
        "message": {
            "role": "user", 
            "content": content
        }
    }

async def run_agent_loop(
    prompt: str,
    images: list | None = None,
    options: ClaudeAgentOptions | None = None,
):
    """Run the Claude Agent SDK query loop for a session."""

    prompt_msg = build_prompt_msg(prompt, images)

    async def prompt_stream():
        yield prompt_msg

    stream_text_msg_id = None
    stream_tool_msg_ids_ordered: list[str] = []
    stream_block_index_map: dict[int, str] = {}
    _turn_number = 0
    _first_event = True

    async for message in query(prompt=prompt_stream(), options=options):

        if isinstance(message, StreamEvent):
            stream_text_msg_id = await _handle_stream_event(
                session_id, message.event,
                stream_text_msg_id, stream_tool_msg_ids_ordered, stream_block_index_map,
            )

        elif isinstance(message, AssistantMessage):
            stream_text_msg_id, stream_tool_msg_ids_ordered, stream_block_index_map = (
                await _handle_assistant_message(
                    session, session_id, message, stream_text_msg_id,
                    stream_tool_msg_ids_ordered, _turn_number,
                    TextBlock, ToolUseBlock,
                )
            )
            _turn_number += 1