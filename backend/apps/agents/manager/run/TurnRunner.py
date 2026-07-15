"""The streaming turn + capacity-retry, lifted out of run_agent_loop so agent_manager stays under
the file ceiling. Faithful relocation as a mixin method (self.sessions / self.live_partial resolve
across the MRO unchanged); turn/thinking are created by the caller and passed in so the loop's
except-handlers can still read them after a mid-stream failure."""

import asyncio
import logging
import time
from typing import Dict, List, Union
from typeguard import typechecked

from backend.apps.agents.core.models import AgentSession
from backend.apps.agents.core.ws_manager import ws_manager
from backend.apps.agents.core.error_classify import CAPACITY_BACKOFFS, capacity_retry_wait
from backend.apps.agents.manager.streaming.state import ThinkingState, TurnState
from backend.apps.agents.manager.streaming.handle_stream_event import handle_stream_event
from backend.apps.agents.manager.streaming.handle_assistant_message import handle_assistant_message
from backend.apps.agents.manager.streaming.handle_result_message import handle_result_message
from backend.apps.agents.manager.run.client_pool import (
    acquire_client,
    boot_fingerprint,
    dispose_client,
    persistent_client_enabled,
)
from backend.apps.agents.manager.streaming import thinking as thinking_mod
from backend.apps.settings.models import AppSettings

logger = logging.getLogger(__name__)


from backend.apps.agents.manager.AgentManagerProtocol import AgentManagerProtocol


class TurnRunner(AgentManagerProtocol):
    # `options` is the SDK ClaudeAgentOptions, lazy-imported below (so mock-mode can import the manager without the SDK present), so it's left unannotated; everything else is typed.
    @typechecked
    async def run_turn_with_retry(self, session: AgentSession, session_id: str,
                                    prompt_content: Union[str, List], options,
                                    options_kwargs: Dict, turn: TurnState, thinking: ThinkingState,
                                    p_stderr_buffer: List[str], resolved_model: str, api_type: str,
                                    global_settings: AppSettings, force_respawn: bool = False) -> None:
        from claude_agent_sdk import query, ClaudeAgentOptions, AssistantMessage, ResultMessage
        from claude_agent_sdk.types import StreamEvent, SystemMessage

        async def prompt_stream():
            yield {
                "type": "user",
                "message": {"role": "user", "content": prompt_content},
            }

        async def p_run_streaming_turn(p_stream=None):
            # Per-turn thinking aggregation trackers (added for the "Thought for Ns · M tokens" persisted label). Without nonlocal, the int reassignments at AssistantMessage emission below shadow them as locals and the dict access at content_block_start crashes with UnboundLocalError.
            # p_stream lets the persistent-client path feed receive_response() through this same consumption loop (one body, two transports).
            async for message in (p_stream if p_stream is not None else query(prompt=prompt_stream(), options=options)):
                if isinstance(message, ResultMessage):
                    turn.current_turn_emitted = False
                else:
                    turn.current_turn_emitted = True
                    # Stamp the turn's wall-clock start at the FIRST non-Result message we see, this is when the user actually started waiting. We use the same timestamp as the basis for "Thought for Ns" so the duration covers thinking + tool exec + assistant text generation.
                    if turn.started_ts is None:
                        turn.started_ts = time.time()
                        # Snapshot cumulative tokens at turn start; subtracted at emit time for per-turn deltas.
                        try:
                            # Baselines track the SAME fresh lane the pill reads, so the per-turn delta is fresh-minus-fresh.
                            if isinstance(session.tokens, dict):
                                turn.baseline_session_in = int(session.tokens.get("input_fresh", 0) or 0)
                                turn.baseline_session_out = int(session.tokens.get("output", 0) or 0)
                            p_ch_in = 0
                            p_ch_out = 0
                            for p_child in self.sessions.values():
                                if getattr(p_child, "parent_session_id", None) != session.id:
                                    continue
                                p_ct = getattr(p_child, "tokens", None)
                                if not isinstance(p_ct, dict):
                                    continue
                                p_ch_in += int(p_ct.get("input_fresh", 0) or 0)
                                p_ch_out += int(p_ct.get("output", 0) or 0)
                            turn.baseline_children_in = p_ch_in
                            turn.baseline_children_out = p_ch_out
                            turn.baseline_captured = True
                        except Exception:
                            pass
                        # Pre-emit thinking pill for routes whose translator strips reasoning content (cx/, gc/, ag/, gemini/). Without this, the pill emits at turn end and lands BELOW the assistant text in session.messages, visually wrong. Pre-emitting here gives the pill the same ordering as Anthropic's natural streaming path. Updates in place at turn end via the stable thinking.msg_id dedupe.
                        try:
                            p_route_strips_reasoning_pre = (
                                isinstance(resolved_model, str)
                                and resolved_model.startswith(("cx/", "gc/", "ag/", "gemini/"))
                            )
                            if p_route_strips_reasoning_pre:
                                await thinking_mod.emit_consolidated_thinking(thinking, turn, session, session_id, self.sessions, force_provider_unavailable=True)
                        except Exception:
                            logger.exception("pre-emit thinking pill failed; continuing")

                if turn.first_event:
                    logger.info(f"[MCP-DEBUG] First event received: {type(message).__name__}")
                    turn.first_event = False

                # Log system messages (MCP server status, errors, etc.)
                if isinstance(message, SystemMessage):
                    raw = message.__dict__ if hasattr(message, '__dict__') else str(message)
                    logger.info(f"[MCP-DEBUG] SystemMessage: {raw}")
                    if getattr(message, "subtype", "") == "compact_boundary":
                        turn.compact_boundaries += 1

                if isinstance(message, StreamEvent):
                    await handle_stream_event(
                        message, session, session_id, turn, thinking, self.live_partial
                    )

                elif isinstance(message, AssistantMessage):
                    await handle_assistant_message(
                        message, session, session_id, turn, thinking, self.live_partial, self.sessions
                    )
                elif isinstance(message, ResultMessage):
                    await handle_result_message(
                        message, session, session_id, turn, thinking, self.sessions,
                        resolved_model, api_type, global_settings,
                    )

        async def p_run_streaming_turn_persistent():
            from claude_agent_sdk import ClaudeSDKClient

            async def p_connect():
                p_client = ClaudeSDKClient(options=options)
                await p_client.connect()
                return p_client

            fp = boot_fingerprint(options_kwargs, session)
            handle = await acquire_client(
                self.client_pool, session_id, fp, p_connect, force_respawn=force_respawn,
            )
            async with handle.lock:
                handle.turns_served += 1
                try:
                    await handle.client.query(prompt_stream())
                    await p_run_streaming_turn(p_stream=handle.client.receive_response())
                    # LRU by turn-END so a session mid-long-turn isn't first cap-evicted the instant it finishes.
                    handle.last_used = time.monotonic()
                except BaseException:
                    # Fail-safe: an error or stop mid-turn poisons the live conversation; drop the client so the next attempt/turn reconnects fresh (== today's one-shot behavior, never worse). Pool pop is sync-first, so even a cancelled disconnect can't leave a reusable stale handle.
                    await dispose_client(self.client_pool, session_id)
                    raise

        p_use_persistent = persistent_client_enabled()
        capacity_retry_attempt = 0
        while True:
            try:
                if p_use_persistent:
                    await p_run_streaming_turn_persistent()
                else:
                    await p_run_streaming_turn()
                break
            except Exception as e:
                # Make sure the consolidated-thinking ticker doesn't outlive the turn on error/retry. Without this, an exception mid-stream leaves a dangling task that keeps re-emitting against a stale msg id.
                if thinking.ticker_task is not None and not thinking.ticker_task.done():
                    thinking.ticker_task.cancel()
                    try:
                        await thinking.ticker_task
                    except (asyncio.CancelledError, Exception):
                        pass
                thinking.ticker_task = None
                stderr_snapshot = "\n".join(p_stderr_buffer[-50:])
                wait = capacity_retry_wait(e, capacity_retry_attempt, extra_text=stderr_snapshot)
                # Persistent-client fail-safe: a dead/wedged CLI raises a connection-class error that the capacity classifier won't retry. The client is already disposed (see p_run_streaming_turn_persistent), so ONE immediate retry reconnects fresh == today's cold behavior; a second failure surfaces normally.
                if wait is None and p_use_persistent and capacity_retry_attempt == 0 and not turn.current_turn_emitted:
                    p_name = type(e).__name__
                    if "CLIConnection" in p_name or "ProcessError" in p_name or "Transport" in p_name:
                        logger.warning(f"[client-pool] {session_id}: dead client ({p_name}); one transparent respawn retry")
                        wait = 0.0
                if wait is not None:
                    capacity_retry_attempt += 1
                    mid_stream = turn.current_turn_emitted
                    logger.warning(
                        f"Transient upstream error on session {session_id} "
                        f"(attempt {capacity_retry_attempt}/{len(CAPACITY_BACKOFFS)}, "
                        f"mid_stream={mid_stream}); sleeping {wait}s before retry. "
                        f"exc={e!r} stderr_tail={stderr_snapshot[-400:]!r}"
                    )
                    # Finalize any in-flight stream messages so the UI doesn't leave them pinned as "still streaming" while we wait and restart. On resume the CLI re-runs the last turn from scratch (Anthropic doesn't persist in-progress responses), so the partial assistant text / tool call we emitted is now orphaned, cap it with stream_end and start the fresh turn under a new message id.
                    if turn.stream_text_msg_id:
                        await ws_manager.send_to_session(session_id, "agent:stream_end", {
                            "session_id": session_id,
                            "message_id": turn.stream_text_msg_id,
                        })
                        turn.stream_text_msg_id = None
                    turn.stream_text_accum = ""
                    self.live_partial.pop(session_id, None)
                    for p_tool_msg_id in turn.stream_tool_msg_ids_ordered:
                        await ws_manager.send_to_session(session_id, "agent:stream_end", {
                            "session_id": session_id,
                            "message_id": p_tool_msg_id,
                        })
                    turn.stream_tool_msg_ids_ordered = []
                    turn.stream_block_index_map = {}
                    turn.current_turn_emitted = False
                    await asyncio.sleep(wait)
                    p_stderr_buffer.clear()
                    if session.sdk_session_id:
                        options_kwargs["resume"] = session.sdk_session_id
                        options = ClaudeAgentOptions(**options_kwargs)
                    continue
                raise

