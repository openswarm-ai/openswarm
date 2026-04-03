from backend.core.shared_structs.agent.Message.Message import (
    AnyMessage, AssistantMessage as AssistantMsg, ToolCallMessage,
)
from backend.core.shared_structs.agent.Message.agent_outputs import ToolCallContent
from backend.core.events.events import EventCallback, AgentMessageEvent
from claude_agent_sdk.types import TextBlock, ToolUseBlock, AssistantMessage as SDKAssistantMessage
from typeguard import typechecked
from typing import List, Optional, Tuple
from uuid import uuid4

HandleAssistantResult = Tuple[Optional[str], List[str], dict, List[AnyMessage]]

@typechecked
async def handle_assistant_message(
    session_id: str, 
    branch_id: str,
    message: SDKAssistantMessage, 
    stream_text_msg_id: Optional[str],
    stream_tool_ids: List[str],
    emit: Optional[EventCallback] = None,
) -> HandleAssistantResult:
    """Handle an assistant message from the Claude Agent SDK.

    Returns (reset stream_text_msg_id, reset stream_tool_ids, reset block_map,
    list of Message objects created during this turn).
    """
    content_parts: List[str] = []
    tool_uses: List[ToolCallContent] = []
    created: List[AnyMessage] = []

    for block in message.content:
        if isinstance(block, TextBlock):
            content_parts.append(block.text)
        elif isinstance(block, ToolUseBlock):
            tool_uses.append(ToolCallContent(id=block.id, tool=block.name, input=block.input))

    if content_parts:
        asst_msg = AssistantMsg(
            id=stream_text_msg_id or uuid4().hex,
            content="\n".join(content_parts),
            branch_id=branch_id,
        )
        created.append(asst_msg)
        if emit:
            await emit(AgentMessageEvent(session_id=session_id, message=asst_msg))

    for i, tu in enumerate(tool_uses):
        mid: str = stream_tool_ids[i] if i < len(stream_tool_ids) else uuid4().hex
        tool_msg = ToolCallMessage(id=mid, content=tu, branch_id=branch_id)
        created.append(tool_msg)
        if emit:
            await emit(AgentMessageEvent(session_id=session_id, message=tool_msg))

    return None, [], {}, created