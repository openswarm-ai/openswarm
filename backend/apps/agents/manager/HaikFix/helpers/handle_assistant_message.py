from backend.apps.agents.manager.ws_manager import ws_manager
from claude_agent_sdk.types import (
    PermissionResultAllow, PermissionResultDeny,
    TextBlock, ToolUseBlock, StreamEvent, SystemMessage,
)

async def handle_assistant_message(
    session, session_id, message, stream_text_msg_id,
    stream_tool_ids
):
    content_parts = []
    tool_uses = []
    for block in message.content:
        if isinstance(block, TextBlock):
            content_parts.append(block.text)
        elif isinstance(block, ToolUseBlock):
            tool_uses.append({"id": block.id, "tool": block.name, "input": block.input})

    if content_parts:
        asst_msg = Message(
            id=stream_text_msg_id or uuid4().hex,
            role="assistant", content="\n".join(content_parts),
            branch_id=session.active_branch_id,
        )
        session.messages.append(asst_msg)
        await ws_manager.emit_message(session_id, asst_msg)

    for i, tu in enumerate(tool_uses):
        mid = stream_tool_ids[i] if i < len(stream_tool_ids) else uuid4().hex
        tool_msg = Message(id=mid, role="tool_call", content=tu, branch_id=session.active_branch_id)
        session.messages.append(tool_msg)
        await ws_manager.emit_message(session_id, tool_msg)