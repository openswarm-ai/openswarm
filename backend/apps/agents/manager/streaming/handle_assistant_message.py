"""Handle a complete AssistantMessage envelope from the SDK: split its blocks into thinking /
text / tool-use, fold the thinking into the consolidated pill, surface a friendly card for a
router auth-expiry that arrived as assistant text, and commit the assistant + tool-call messages.
Lifted out of the agent loop; mutates the passed TurnState / ThinkingState by reference and writes
through the manager's live-partial mirror + session registry, exactly as it did inline."""

import asyncio
import logging
from typing import Dict, Optional
from uuid import uuid4

from typeguard import typechecked

from backend.apps.agents.core.models import AgentSession, Message
from backend.apps.agents.core.ws_manager import ws_manager
from backend.apps.agents.manager.streaming.state import ThinkingState, TurnState
from backend.apps.agents.manager.streaming.upsert_message import upsert_message
from backend.apps.agents.manager.streaming.PartialReply import PartialReply
from backend.apps.agents.manager.streaming import thinking as thinking_mod

logger = logging.getLogger(__name__)

# The block types drive isinstance DISPATCH, so they must be real at runtime; imported inside the handler because by stream time the SDK is already resident (the turn's presence check imported it), keeping the 350ms sdk+mcp chain off the boot graph.
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from claude_agent_sdk import AssistantMessage
else:
    AssistantMessage = object


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
    from claude_agent_sdk.types import ThinkingBlock, TextBlock, ToolUseBlock

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
            from backend.apps.agents.manager.context_budget import maybe_break_midturn
            if maybe_break_midturn(session, turn, msg_usage):
                logging.getLogger(__name__).warning(
                    f"[context-break] session {session_id}: mid-turn input "
                    f"{session.tokens.get('input')} crossed the compact trigger; breaking at the "
                    "next message boundary and continuing on a fresh compacted session"
                )
                try:
                    from backend.apps.service.client import submit_diagnostic
                    submit_diagnostic({
                        "kind": "context_midturn_break",
                        "session_id": session_id,
                        "model": session.model,
                        "input_tokens": session.tokens.get("input"),
                        "context_window": session.context_window,
                    })
                except Exception:
                    pass
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
        # One door for everything the provider says, so classify the class here instead of adding a fifth phrasing above; measured 14/14 caught, 0 false positives on 2035 real assistant messages.
        from backend.apps.agents.manager.streaming.provider_error_speech import (
            AUTH as P_ERR_AUTH,
            POLICY as P_ERR_POLICY,
            classify_provider_error,
            is_transient,
            user_facing_sentence,
        )
        p_provider_error = None
        if not looks_like_router_auth_error:
            p_provider_error = classify_provider_error(asst_text)
            if p_provider_error is not None and p_provider_error.kind == P_ERR_POLICY:
                # The policy filter answered in the assistant's place. The run-error path owns this failure (recap ratchet, honest card, telemetry); carding "retrying automatically" here while nothing retried was the lie Alex read before every bricked turn.
                from backend.apps.agents.manager.streaming.handle_result_message import TurnResultError
                raise TurnResultError(asst_text)
            if p_provider_error is not None and p_provider_error.kind == P_ERR_AUTH:
                # Same failure the phrase list was written for, so it goes to the same healer; two mechanisms for one condition is the ENG-252 mistake.
                looks_like_router_auth_error = True
                p_provider_error = None

        if looks_like_router_auth_error:
            from backend.apps.agents.manager.streaming.auth_retry import try_auth_self_heal
            p_is_codex = "codex/" in lower_text or "[codex" in lower_text
            # First expiry in this ask heals silently (fresh CLI + hidden retry); the banner is
            # reserved for the second failure, when the credential is genuinely dead (ENG-294).
            # Codex retries wait ~75s so they land AFTER the 1-2 minute rotation window instead of
            # inside it (an instant retry re-fails and burns the one-shot budget).
            p_healed = try_auth_self_heal(session, delay_s=75 if p_is_codex else 5)
            if p_healed and p_is_codex:
                p_notice = Message(
                    id=uuid4().hex,
                    role="system",
                    content="GPT subscription token just rotated (automatic, every couple minutes). Retrying your request automatically in about a minute, no action needed.",
                    branch_id=session.active_branch_id,
                )
                session.messages.append(p_notice)
                await ws_manager.send_to_session(session_id, "agent:message", {
                    "session_id": session_id,
                    "message": p_notice.model_dump(mode="json"),
                })
            if not p_healed:
                if p_is_codex:
                    friendly = (
                        "GPT subscription token is still refreshing. This usually clears on "
                        "its own; wait a minute and send your message again. If it keeps "
                        "happening, open Settings → Models and click Reconnect on the "
                        "OpenAI / GPT row."
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
        elif p_provider_error is not None:
            # The provider failed, the agent never spoke; say what happens next and, when waiting fixes it, do the waiting for them.
            from backend.apps.agents.manager.streaming.auth_retry import try_transient_self_heal

            p_delay = 0
            p_healed = False
            # A verdict waiting cannot change ends the ask's recovery ladder. Without this, the
            # retries kept running after we had already told the user to switch models, and each
            # one added a card contradicting that advice (packaged drill: seven cards, three
            # mutually exclusive instructions, twice).
            if not is_transient(p_provider_error):
                session.provider_verdict_final = True
            elif not session.provider_verdict_final:
                p_delay = min(int(p_provider_error.reset_seconds or 0), 900)
                p_healed = try_transient_self_heal(session, delay_s=p_delay)

            if p_healed:
                p_copy = user_facing_sentence(p_provider_error, session.model or "")
            else:
                p_copy = (
                    user_facing_sentence(p_provider_error, session.model or "")
                    if not is_transient(p_provider_error)
                    else (
                        "The model provider kept returning a temporary error, so this step could "
                        "not finish. Send your message again, or switch this agent to another "
                        "model."
                    )
                )
            p_card = Message(
                id=uuid4().hex,
                role="system",
                content=p_copy,
                branch_id=session.active_branch_id,
            )
            # Dedup by KIND, not by exact string. The identical-card absorber never engaged here
            # because consecutive cards alternated wording (spent plan / rate limit / spent plan),
            # so the same underlying failure stacked a wall. One card per kind per ask; a repeat
            # rewrites it in place so the newest wording wins without adding a row.
            p_prev_kind = getattr(session, "last_provider_error_kind", "")
            p_existing = None
            if p_prev_kind == p_provider_error.kind:
                for m in reversed(session.messages):
                    if m.role == "system" and not getattr(m, "hidden", False):
                        p_existing = m
                        break
            if p_existing is not None:
                p_existing.content = p_copy
                p_existing.timestamp = p_card.timestamp
                p_card = p_existing
            else:
                from backend.apps.agents.manager.run.handle_run_error import absorb_repeat_card
                absorb_repeat_card(session, p_card)
            session.last_provider_error_kind = p_provider_error.kind
            logger.warning(
                f"Agent {session_id}: provider returned {p_provider_error.kind} "
                f"(status={p_provider_error.status}, lane={p_provider_error.lane}) as assistant "
                f"text; surfaced as a card instead of the agent's own words "
                f"(retry_queued={p_healed}, delay={p_delay}s)"
            )
            await ws_manager.send_to_session(session_id, "agent:message", {
                "session_id": session_id,
                "message": p_card.model_dump(mode="json"),
            })
        else:
            # Drill seam: swallow the model's answer so the turn genuinely ends mute after tool work,
            # which is the real shape of a silent quit. Forcing the DECISION further downstream was a
            # proxy: it ran the guard while an answer still sat in the transcript, so it could never
            # show whether the user actually gets their result back.
            from backend.apps.agents.core.fault_injection import armed as p_fault_armed
            if p_fault_armed("empty_finish"):
                turn.stream_text_accum = ""
                live_partial.pop(session_id, None)
                return
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

