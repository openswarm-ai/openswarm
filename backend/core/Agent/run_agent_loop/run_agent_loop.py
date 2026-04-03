from typeguard import typechecked

from claude_agent_sdk import (
    query, ClaudeAgentOptions, AssistantMessage,
)
from claude_agent_sdk.types import StreamEvent
from backend.core.Agent.run_agent_loop.helpers.handle_stream_event import handle_stream_event
from backend.core.Agent.run_agent_loop.helpers.handle_assistant_message import handle_assistant_message
from backend.core.shared_structs.agent.Message.Message import Message, PromptMsgDict
from backend.core.events.events import EventCallback
from typing import List, Dict, Optional

@typechecked
async def run_agent_loop(
    msg: Message,
    options: ClaudeAgentOptions | None = None,
    branch_id: str | None = None,
    emit: Optional[EventCallback] = None,
):
    """Run the Claude Agent SDK query loop for a session."""

    prompt_msg: PromptMsgDict = msg.to_prompt()

    async def prompt_stream():
        yield prompt_msg

    stream_text_msg_id: Optional[str] = None
    stream_tool_msg_ids_ordered: List[str] = []
    stream_block_index_map: Dict[int, str] = {}

    async for message in query(prompt=prompt_stream(), options=options):

        if isinstance(message, StreamEvent):
            stream_text_msg_id = await handle_stream_event(
                session_id=options.session_id, 
                event=message.event,
                stream_text_msg_id=stream_text_msg_id,
                stream_tool_ids=stream_tool_msg_ids_ordered,
                block_map=stream_block_index_map,
                emit=emit,
            )

        elif isinstance(message, AssistantMessage):
            stream_text_msg_id, stream_tool_msg_ids_ordered, stream_block_index_map = (
                await handle_assistant_message(
                    session_id=options.session_id,
                    branch_id=branch_id,
                    message=message,
                    stream_text_msg_id=stream_text_msg_id,
                    stream_tool_ids=stream_tool_msg_ids_ordered,
                    emit=emit,
                )
            )