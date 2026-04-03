from backend.apps.HaikFix.Agent.shared_structs.Message.Message import Message
from backend.apps.HaikFix.Agent.shared_structs.Message.agent_outputs import ToolCallContent
from backend.apps.HaikFix.Agent.shared_structs.events import EventCallback, AgentMessageEvent
from claude_agent_sdk.types import TextBlock, ToolUseBlock, AssistantMessage
from typeguard import typechecked
from typing import List, Optional
from uuid import uuid4

@typechecked
async def handle_assistant_message(
    session_id: str, 
    branch_id: str,
    message: AssistantMessage, 
    stream_text_msg_id: str,
    stream_tool_ids: List[str],
    emit: Optional[EventCallback] = None,
):
    """Handle an assistant message from the Claude Agent SDK.
    
    NOTE: Does not save the message to the Agent's MessageLog yet.
    The caller (run_agent_loop / Agent) is responsible for persistence.
    """
    content_parts: List[str] = []
    tool_uses: List[ToolCallContent] = []
    for block in message.content:
        if isinstance(block, TextBlock):
            content_parts.append(block.text)
        elif isinstance(block, ToolUseBlock):
            tool_uses.append(ToolCallContent(id=block.id, tool=block.name, input=block.input))

    if content_parts:
        asst_msg: Message = Message(
            id=stream_text_msg_id or uuid4().hex,
            role="assistant", content="\n".join(content_parts),
            branch_id=branch_id,
        )
        if emit:
            await emit(AgentMessageEvent(
                session_id=session_id,
                message=asst_msg,
            ))

    for i, tu in enumerate[ToolCallContent](tool_uses):
        mid: str = stream_tool_ids[i] if i < len(stream_tool_ids) else uuid4().hex
        tool_msg: Message = Message(id=mid, role="tool_call", content=tu, branch_id=branch_id)
        if emit:
            await emit(AgentMessageEvent(
                session_id=session_id,
                message=tool_msg,
            ))