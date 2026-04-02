import logging
from typeguard import typechecked

from claude_agent_sdk import (
    query, ClaudeAgentOptions, AssistantMessage,
)
from claude_agent_sdk.types import StreamEvent
from backend.apps.agents.manager.HaikFix.run_agent_loop.helpers.handle_stream_event import handle_stream_event
from backend.apps.agents.manager.HaikFix.run_agent_loop.helpers.handle_assistant_message import handle_assistant_message

from backend.apps.agents.manager.HaikFix.shared_structs.PromptChunks import (
    ImageChunk, ImageChunkDict, TextChunk, TextChunkDict
)
from typing import List, Dict, Literal, Union, Optional

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

@typechecked
async def run_agent_loop(
    prompt: str,
    images: Optional[List[ImageChunk]] = None,
    options: ClaudeAgentOptions | None = None,
    branch_id: str | None = None,
):
    """Run the Claude Agent SDK query loop for a session."""

    prompt_msg = build_prompt_msg(prompt=prompt, images=images)

    async def prompt_stream():
        yield prompt_msg

    stream_text_msg_id: Optional[str] = None
    stream_tool_msg_ids_ordered: List[str] = []
    stream_block_index_map: Dict[int, str] = {}
    _turn_number: int = 0
    _first_event: bool = True

    async for message in query(prompt=prompt_stream(), options=options):

        if isinstance(message, StreamEvent):
            stream_text_msg_id = await handle_stream_event(
                session_id=options.session_id, 
                event=message.event,
                stream_text_msg_id=stream_text_msg_id,
                stream_tool_ids=stream_tool_msg_ids_ordered,
                block_map=stream_block_index_map,
            )

        elif isinstance(message, AssistantMessage):
            stream_text_msg_id, stream_tool_msg_ids_ordered, stream_block_index_map = (
                await handle_assistant_message(
                    session_id=options.session_id,
                    branch_id=branch_id,
                    message=message,
                    stream_text_msg_id=stream_text_msg_id,
                    stream_tool_ids=stream_tool_msg_ids_ordered,
                )
            )
            _turn_number += 1