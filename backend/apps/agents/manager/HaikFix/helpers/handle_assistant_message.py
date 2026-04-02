from backend.apps.agents.manager.HaikFix.helpers.Message import Message, ToolCallContent
from claude_agent_sdk.types import TextBlock, ToolUseBlock, AssistantMessage
from backend.apps.agents.manager.ws_manager import ws_manager
from typeguard import typechecked
from typing import List
from uuid import uuid4

@typechecked
async def handle_assistant_message(
    session_id: str, 
    branch_id: str,
    message: AssistantMessage, 
    stream_text_msg_id: str,
    stream_tool_ids: List[str],
):
    """Handle an assistant message from the Claude Agent SDK."""
    # NOTE: Does not acctually save the message to the session.
    # TODO: Save the message to the session -Haik
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
        await ws_manager.emit_message(session_id, asst_msg)

    for i, tu in enumerate[ToolCallContent](tool_uses):
        mid: str = stream_tool_ids[i] if i < len(stream_tool_ids) else uuid4().hex
        tool_msg: Message = Message(id=mid, role="tool_call", content=tu, branch_id=branch_id)
        await ws_manager.emit_message(session_id, tool_msg)