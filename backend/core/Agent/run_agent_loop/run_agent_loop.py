import asyncio
import traceback

from swarm_debug import debug
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

    stderr_lines: List[str] = []
    original_stderr = options.stderr

    def capture_stderr(line: str) -> None:
        stderr_lines.append(line)
        debug(f"[claude-cli stderr] {line}")
        if original_stderr:
            original_stderr(line)

    options.stderr = capture_stderr

    async def prompt_stream():
        yield prompt_msg

    stream_text_msg_id: Optional[str] = None
    stream_tool_msg_ids_ordered: List[str] = []
    stream_block_index_map: Dict[int, str] = {}

    debug(f"Starting query for agent {session_id}",
          f"model={options.model}",
          f"env_keys={list(options.env.keys()) if options.env else 'none'}",
          f"permission_mode={options.permission_mode}",
          f"max_turns={options.max_turns}")

    try:
        async for message in query(prompt=prompt_stream(), options=options):

            if isinstance(message, StreamEvent):
                debug(f"[agent {session_id}] stream: {message.event.get('type', '?')}")
                stream_text_msg_id = await handle_stream_event(
                    session_id=session_id,
                    event=message.event,
                    stream_text_msg_id=stream_text_msg_id,
                    stream_tool_ids=stream_tool_msg_ids_ordered,
                    block_map=stream_block_index_map,
                    emit=emit,
                )

            elif isinstance(message, AssistantMessage):
                content_preview = str(message.content)[:200]
                debug(f"[agent {session_id}] assistant: {content_preview}")
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

        debug(f"[agent {session_id}] completed successfully")
        if emit:
            await emit(AgentStatusEvent(session_id=session_id, status="completed"))

    except asyncio.CancelledError:
        if emit:
            await emit(AgentStatusEvent(session_id=session_id, status="stopped"))
        raise

    except Exception as e:
        tb = "".join(traceback.format_exception(type(e), e, e.__traceback__))
        stderr_output = "\n".join(stderr_lines) if stderr_lines else "(no stderr captured)"
        debug(f"Agent {session_id} error:\n{tb}\n--- CLI stderr ---\n{stderr_output}")
        error_msg = SystemMessage(
            content=f"Error: {e}",
            branch_id=branch_id,
        )
        messages.append(error_msg)
        if emit:
            await emit(AgentMessageEvent(session_id=session_id, message=error_msg))
            await emit(AgentStatusEvent(session_id=session_id, status="error"))