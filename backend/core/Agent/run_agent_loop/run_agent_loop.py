import asyncio
import logging

from typeguard import typechecked

from claude_agent_sdk import (
    query, ClaudeAgentOptions, AssistantMessage,
)
from claude_agent_sdk.types import StreamEvent
from backend.core.Agent.run_agent_loop.helpers.handle_stream_event import handle_stream_event
from backend.core.Agent.run_agent_loop.helpers.handle_assistant_message import handle_assistant_message
from backend.core.shared_structs.agent.Message.Message import (
    SystemMessage, PromptMsgDict,
)
from backend.core.shared_structs.agent.MessageLog import MessageLog
from backend.core.events.events import (
    EventCallback, AgentStatusEvent, AgentMessageEvent,
)
from typing import List, Dict, Optional

logger = logging.getLogger(__name__)


@typechecked
async def run_agent_loop(
    prompt_msg: PromptMsgDict,
    messages: MessageLog,
    options: ClaudeAgentOptions,
    session_id: str,
    branch_id: str = "main",
    emit: Optional[EventCallback] = None,
):
    """Run the Claude Agent SDK query loop for a session.

    Streams events to the frontend via `emit` and persists every
    assistant / tool_call message into `messages`.
    """

    async def prompt_stream():
        yield prompt_msg

    stream_text_msg_id: Optional[str] = None
    stream_tool_msg_ids_ordered: List[str] = []
    stream_block_index_map: Dict[int, str] = {}

    try:
        async for message in query(prompt=prompt_stream(), options=options):

            if isinstance(message, StreamEvent):
                stream_text_msg_id = await handle_stream_event(
                    session_id=session_id,
                    event=message.event,
                    stream_text_msg_id=stream_text_msg_id,
                    stream_tool_ids=stream_tool_msg_ids_ordered,
                    block_map=stream_block_index_map,
                    emit=emit,
                )

            elif isinstance(message, AssistantMessage):
                stream_text_msg_id, stream_tool_msg_ids_ordered, stream_block_index_map, created = (
                    await handle_assistant_message(
                        session_id=session_id,
                        branch_id=branch_id,
                        message=message,
                        stream_text_msg_id=stream_text_msg_id,
                        stream_tool_ids=stream_tool_msg_ids_ordered,
                        emit=emit,
                    )
                )
                for msg in created:
                    messages.append(msg)

        if emit:
            await emit(AgentStatusEvent(session_id=session_id, status="completed"))

    except asyncio.CancelledError:
        if emit:
            await emit(AgentStatusEvent(session_id=session_id, status="stopped"))
        raise

    except Exception as e:
        logger.exception("Agent %s error: %s", session_id, e)
        error_msg = SystemMessage(
            content=f"Error: {e}",
            branch_id=branch_id,
        )
        messages.append(error_msg)
        if emit:
            await emit(AgentMessageEvent(session_id=session_id, message=error_msg))
            await emit(AgentStatusEvent(session_id=session_id, status="error"))