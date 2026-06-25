"""Handle a complete AssistantMessage envelope from the SDK: split its blocks into thinking /
text / tool-use, fold the thinking into the consolidated pill, surface a friendly card for a
router auth-expiry that arrived as assistant text, and commit the assistant + tool-call messages.
Lifted out of the agent loop; mutates the passed TurnState / ThinkingState by reference and writes
through the manager's live-partial mirror + session registry, exactly as it did inline."""

import asyncio
from typing import Dict, Optional
from uuid import uuid4

from typeguard import typechecked

from backend.apps.agents.core.models import AgentSession, Message
from backend.apps.agents.core.ws_manager import ws_manager
from backend.apps.agents.manager.streaming.state import ThinkingState, TurnState
from backend.apps.agents.manager.streaming.upsert_message import upsert_message
from backend.apps.agents.manager.streaming.PartialReply import PartialReply
from backend.apps.agents.manager.streaming import thinking as thinking_mod

try:
    from claude_agent_sdk import AssistantMessage
    from claude_agent_sdk.types import ThinkingBlock, TextBlock, ToolUseBlock
except ImportError:  # the SDK is optional at runtime (mock mode); keep this module importable
    AssistantMessage = ThinkingBlock = TextBlock = ToolUseBlock = object  # type: ignore


@typechecked
async def handle_assistant_message(
    message: AssistantMessage,
    session: AgentSession,
    session_id: str,
    turn: TurnState,
    thinking: ThinkingState,
    live_partial: Dict[str, PartialReply],
    sessions: Dict[str, AgentSession],
) -> None:
    content_parts = []
    new_thinking_parts = []
    tool_uses = []
    # Capture the latest Gemini thoughtSignature (and Anthropic's signature_delta if present) off any ThinkingBlock in this message. We store it on the turn's consolidated thinking message so it survives session.json serialization, and re-attach it on the next request so Google's continuity check passes.
    new_thought_signature: Optional[str] = None
    for block in message.content:
        if isinstance(block, ThinkingBlock):
            thinking_text = getattr(block, "thinking", None) or getattr(block, "text", None) or ""
            if thinking_text:
                new_thinking_parts.append(thinking_text)
            # Try multiple field-name variants, SDK versions and 9Router translations have used `signature`, `thoughtSignature`, and `thought_signature` over time.
            sig = (
                getattr(block, "signature", None)
                or getattr(block, "thoughtSignature", None)
                or getattr(block, "thought_signature", None)
            )
            if sig:
                new_thought_signature = sig
        elif isinstance(block, TextBlock):
            content_parts.append(block.text)
        elif isinstance(block, ToolUseBlock):
            tool_uses.append({
                "id": block.id,
                "tool": block.name,
                "input": block.input,
            })

    # Accumulate this AssistantMessage's contributions into the turn-level thinking pill. We re-emit the SAME message id each time so the frontend dedupes (addMessage replaces by id) and the bubble updates live as more thought / tools arrive. This is what gives us "Thought for 18s · 412 tokens · 3 tools used" reflecting the whole turn rather than just one think-step. NOTE: tool count is incremented in the content_block_start (block_type=="tool_use") branch above, NOT here. That path fires for both Anthropic and 9Router-translated providers; counting again here would double. If a provider somehow doesn't surface content_block_start for tool blocks but DOES surface them in the AssistantMessage envelope (defensive case), the max() in the consolidated emit will still pick up the higher count.
    if new_thinking_parts:
        thinking.text_parts.extend(new_thinking_parts)
    # Latch the most recent thoughtSignature, Gemini only validates against the LATEST one in the conversation history, so older signatures from earlier think-steps in the same turn are superseded by newer ones.
    if new_thought_signature:
        thinking.thought_signature = new_thought_signature
    # Accumulate this message's total output tokens (SDK populates `usage.output_tokens` with the full output for the inference: thinking text + visible text + tool-call JSON args). Summing across the turn's AssistantMessages gives us "all output the model produced this turn," which is what users intuit when they see a token count.
    try:
        msg_usage = getattr(message, "usage", None) or {}
        if isinstance(msg_usage, dict):
            ot = int(msg_usage.get("output_tokens", 0) or 0)
            if ot > 0:
                turn.output_tokens += ot
    except Exception:
        pass

    # Re-emit the consolidated thinking message on every AssistantMessage (event-driven). The background ticker loop keeps it updating between events too, so the elapsed counter ticks even during tool execution / slow text generation gaps.
    if thinking.text_parts:
        await thinking_mod.emit_consolidated_thinking(thinking, turn, session, session_id, sessions)
        # Start the 1Hz ticker once we have a consolidated message in flight so the bubble keeps updating between SDK events.
        if thinking.ticker_task is None or thinking.ticker_task.done():
            thinking.ticker_task = asyncio.create_task(thinking_mod.ticker_loop(thinking, turn, session, session_id, sessions))

    if content_parts:
        asst_text = "\n".join(content_parts)
        # 9Router sometimes returns upstream 401s as the assistant reply (no SDK exception), so the catch-all auth handler never fires. Match the text pattern and surface a friendly system bubble instead.
        lower_text = asst_text.lower()
        looks_like_router_auth_error = (
            ("failed to authenticate" in lower_text and "401" in lower_text)
            or ("authentication token is expired" in lower_text)
            or ("authentication token has expired" in lower_text)
            or ("provided authentication token" in lower_text and ("401" in lower_text or "expired" in lower_text))
        )
        if looks_like_router_auth_error:
            if "codex/" in lower_text or "[codex" in lower_text:
                friendly = (
                    "GPT subscription token expired. Open Settings → Models and click "
                    "Reconnect on the OpenAI / GPT row to refresh, should take ~10s, "
                    "then send your message again."
                )
                reason = "codex_token_expired"
            elif "gemini-cli/" in lower_text or "[gemini" in lower_text:
                friendly = (
                    "Gemini subscription token expired. Open Settings → Models and click "
                    "Reconnect on the Google / Gemini row, then send your message again."
                )
                reason = "gemini_token_expired"
            else:
                friendly = (
                    "Provider authentication expired. Open Settings → Models and "
                    "reconnect, then send your message again."
                )
                reason = "router_auth_expired"
            err_msg = Message(
                id=uuid4().hex,
                role="system",
                content=friendly,
                branch_id=session.active_branch_id,
            )
            session.messages.append(err_msg)
            await ws_manager.send_to_session(session_id, "agent:auth_error", {
                "session_id": session_id,
                "reason": reason,
                "message": friendly,
                "model": session.model,
            })
            await ws_manager.send_to_session(session_id, "agent:message", {
                "session_id": session_id,
                "message": err_msg.model_dump(mode="json"),
            })
        else:
            asst_msg = Message(
                id=turn.stream_text_msg_id or uuid4().hex,
                role="assistant",
                content=asst_text,
                branch_id=session.active_branch_id,
            )
            upsert_message(session, asst_msg)
            turn.stream_text_accum = ""
            live_partial.pop(session_id, None)
            await ws_manager.send_to_session(session_id, "agent:message", {
                "session_id": session_id,
                "message": asst_msg.model_dump(mode="json"),
            })

    for i, tu in enumerate(tool_uses):
        msg_id = turn.stream_tool_msg_ids_ordered[i] if i < len(turn.stream_tool_msg_ids_ordered) else uuid4().hex
        tool_msg = Message(id=msg_id, role="tool_call", content=tu, branch_id=session.active_branch_id)
        upsert_message(session, tool_msg)
        await ws_manager.send_to_session(session_id, "agent:message", {
            "session_id": session_id,
            "message": tool_msg.model_dump(mode="json"),
        })

    turn.number += 1

    turn.stream_text_msg_id = None
    turn.stream_tool_msg_ids_ordered = []
    turn.stream_block_index_map = {}

