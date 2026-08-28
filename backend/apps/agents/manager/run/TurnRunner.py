"""The streaming turn + capacity-retry, lifted out of run_agent_loop so agent_manager stays under
the file ceiling. Faithful relocation as a mixin method (self.sessions / self.live_partial resolve
across the MRO unchanged); turn/thinking are created by the caller and passed in so the loop's
except-handlers can still read them after a mid-stream failure."""

import asyncio
import logging
import time
from typing import Dict, List, Union, cast
from typeguard import typechecked

from backend.apps.agents.core.models import AgentSession
from backend.apps.agents.core.ws_manager import ws_manager
from backend.apps.agents.core.error_classify import CAPACITY_BACKOFFS, auth_resume_wait, capacity_retry_wait, is_router_unreachable_error
from backend.apps.agents.core import flight_recorder
from backend.apps.agents.manager.streaming.state import ThinkingState, TurnState
from backend.apps.agents.manager.streaming.handle_stream_event import handle_stream_event
from backend.apps.agents.manager.streaming.handle_assistant_message import handle_assistant_message
from backend.apps.agents.manager.streaming.handle_result_message import TurnResultError, handle_result_message
from backend.apps.agents.manager.streaming.note_provider_retry import note_provider_retry, settle_provider_retries
from backend.apps.agents.manager.streaming.core_mcp_health import note_core_mcp_health
from backend.apps.agents.manager.run.client_pool import (
    SdkClientLike,
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
        from backend.apps.agents.core.fault_injection import armed as p_fault_armed, armed_once as p_fault_once

        # Deliberate faults, so the guards below get drilled instead of waited for. Inert unless
        # OSW_FAULT names them; a shipped build never sets it. Raised HERE because this is the same
        # door a real provider failure comes through, so the drill exercises the real recovery.
        if p_fault_armed("policy_block"):
            # The provider's real wording, so the drill hits the same classifier a field block does.
            raise RuntimeError(
                "API Error: 400 {\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"message\":"
                "\"Output blocked as it seems to violate our Acceptable Use Policy (legal/aup): "
                "reverse engineering or duplicating model outputs\"}}"
            )
        if p_fault_armed("auth_401"):
            raise RuntimeError("API Error: 401 {\"error\":{\"type\":\"authentication_error\",\"message\":\"invalid x-api-key\"}}")
        # One-shot: a dead pipe is recoverable, so the drill needs the retry to find a clear road.
        # The type must be one the REAL classifier calls a lost connection, or the drill quietly
        # measures the unclassified fall-through instead of the transport heal (caught doing exactly
        # that: anyio.BrokenResourceError is not in the transient set and read as a poisoned session).
        if p_fault_once("transport_death"):
            raise ConnectionError("injected transport death (OSW_FAULT)")

        async def prompt_stream():
            yield {
                "type": "user",
                "message": {"role": "user", "content": prompt_content},
            }

        async def p_run_streaming_turn(p_stream=None):
            # Per-turn thinking aggregation trackers (added for the "Thought for Ns · M tokens" persisted label). Without nonlocal, the int reassignments at AssistantMessage emission below shadow them as locals and the dict access at content_block_start crashes with UnboundLocalError.
            # p_stream lets the persistent-client path feed receive_response() through this same consumption loop (one body, two transports).
            async for message in (p_stream if p_stream is not None else query(prompt=prompt_stream(), options=options)):
                # MCPActivate tells the model its new tools are not callable yet and to stop. Asking
                # was not enough: it kept going and guessed names like `send email`, which is what
                # made every MCP task look broken. The activated tools genuinely do not exist until
                # the transport is rebuilt, so end the turn here and let the auto-continuation fire
                # with the real names. Checked before the message is handled, so the model's next
                # move after activating never runs.
                if getattr(session, "pending_continuation", False):
                    break
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
                    flight_recorder.crumb(session_id, "first-event", kind=type(message).__name__)
                    turn.first_event = False

                # Active-time ledger: count the gap since the previous event, capped so a stall
                # (approval wait, paused workflow, provider backoff) can't book its wall-clock.
                p_now_ts = time.time()
                if turn.last_event_ts is not None:
                    turn.active_ms += int(min(p_now_ts - turn.last_event_ts, 30.0) * 1000)
                turn.last_event_ts = p_now_ts

                # Log system messages (MCP server status, errors, etc.)
                if isinstance(message, SystemMessage):
                    raw = message.__dict__ if hasattr(message, '__dict__') else str(message)
                    logger.info(f"[MCP-DEBUG] SystemMessage: {raw}")
                    p_subtype = getattr(message, "subtype", "")
                    if p_subtype == "init":
                        # The CLI states its MCP connection status here; a core server that never
                        # connected means a session with none of its tools, forever (ENG-303).
                        note_core_mcp_health(session, session_id, raw)
                    if p_subtype == "compact_boundary":
                        turn.compact_boundaries += 1
                        session.cli_compactions += 1
                    elif p_subtype == "api_retry":
                        note_provider_retry(session_id, raw, turn)

                if isinstance(message, StreamEvent):
                    await handle_stream_event(
                        message, session, session_id, turn, thinking, self.live_partial
                    )

                elif isinstance(message, AssistantMessage):
                    flight_recorder.crumb(session_id, "assistant-msg")
                    await handle_assistant_message(
                        message, session, session_id, turn, thinking, self.live_partial, self.sessions
                    )
                elif isinstance(message, ResultMessage):
                    flight_recorder.crumb(session_id, "result-msg", subtype=str(getattr(message, "subtype", "")))
                    await handle_result_message(
                        message, session, session_id, turn, thinking, self.sessions,
                        resolved_model, api_type, global_settings,
                    )

        async def p_run_streaming_turn_persistent():
            from claude_agent_sdk import ClaudeSDKClient

            async def p_connect():
                p_client = ClaudeSDKClient(options=options)
                logger.info(f"[SPAWN-PHASE] cli-connect start session={session_id[:8]} t={time.monotonic():.3f}")
                flight_recorder.crumb(session_id, "cli-connect-start")
                await p_client.connect()
                logger.info(f"[SPAWN-PHASE] cli-connect done session={session_id[:8]} t={time.monotonic():.3f}")
                flight_recorder.crumb(session_id, "cli-connect-done")
                return p_client

            fp = boot_fingerprint(options_kwargs, session)
            logger.info(f"[SPAWN-PHASE] client-acquire start session={session_id[:8]} t={time.monotonic():.3f}")
            flight_recorder.crumb(session_id, "client-acquire")
            handle = await acquire_client(
                self.client_pool, session_id, fp, p_connect, force_respawn=force_respawn,
            )
            async with handle.lock:
                handle.turns_served += 1
                try:
                    sdk = cast(SdkClientLike, handle.client)
                    await sdk.query(prompt_stream())
                    await p_run_streaming_turn(p_stream=sdk.receive_response())
                    # LRU by turn-END so a session mid-long-turn isn't first cap-evicted the instant it finishes.
                    handle.last_used = time.monotonic()
                except BaseException:
                    # Fail-safe: an error or stop mid-turn poisons the live conversation; drop the client so the next attempt/turn reconnects fresh (== today's one-shot behavior, never worse). Pool pop is sync-first, so even a cancelled disconnect can't leave a reusable stale handle.
                    await dispose_client(self.client_pool, session_id)
                    raise

        async def p_finalize_interrupted_stream():
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

        p_use_persistent = persistent_client_enabled()
        capacity_retry_attempt = 0
        p_router_retry_attempt = 0
        p_auth_retry_attempt = 0
        # Baseline crumb so even a first-call failure's envelope names the turn it died in.
        flight_recorder.crumb(session_id, "turn-start", model=resolved_model, api=api_type)
        while True:
            try:
                if p_use_persistent:
                    await p_run_streaming_turn_persistent()
                else:
                    await p_run_streaming_turn()
                # The near-miss ledger: a turn that needed retries and still finished is a net that
                # FIRED, and "how often do the nets fire" needs a denominator in analytics.
                if p_router_retry_attempt or capacity_retry_attempt or p_auth_retry_attempt:
                    flight_recorder.record_recovery(
                        session_id,
                        net="router-resume" if p_router_retry_attempt else ("auth-resume" if p_auth_retry_attempt else "transient-backoff"),
                        model=resolved_model,
                        attempts=p_router_retry_attempt + capacity_retry_attempt + p_auth_retry_attempt,
                        sessions=self.sessions,
                    )
                settle_provider_retries(session_id, turn, resolved_model, self.sessions)
                break
            except TurnResultError as p_result_err:
                # "Unable to connect" in a turn result is the CLI failing to reach our own localhost
                # router, which a dev reload kills and the watchdog revives within seconds. The CLI
                # transcript keeps the tools that already ran, so a resume continues the SAME
                # conversation without re-executing side effects: re-ensure the router, resume, go.
                if p_router_retry_attempt < 2 and is_router_unreachable_error(str(p_result_err)):
                    p_router_retry_attempt += 1
                    flight_recorder.crumb(session_id, "router-retry", attempt=p_router_retry_attempt, err=str(p_result_err)[:160])
                    logger.warning(
                        f"Router unreachable mid-turn on session {session_id} "
                        f"(attempt {p_router_retry_attempt}/2); re-ensuring router and resuming. "
                        f"err={p_result_err!s}"
                    )
                    try:
                        from backend.apps.nine_router.process import ensure_running
                        await ensure_running()
                    except Exception:
                        logger.exception("Router re-ensure failed; resuming anyway after the wait")
                    await p_finalize_interrupted_stream()
                    await asyncio.sleep(2.0 if p_router_retry_attempt == 1 else 5.0)
                    p_stderr_buffer.clear()
                    if session.sdk_session_id:
                        options_kwargs["resume"] = session.sdk_session_id
                        options = ClaudeAgentOptions(**options_kwargs)
                    continue
                # A token that expired MID-RUN is the auth twin of the router blip: the account is
                # fine, the credential rotated under a long task (Alexander, 2026-08-14: every big
                # task died at the reconnect banner). One refresh-and-resume; a real subscription
                # state (canceled, past_due, trial spent) never qualifies and still dies honestly.
                p_auth_wait = auth_resume_wait(p_result_err, p_auth_retry_attempt, extra_text="\n".join(p_stderr_buffer[-50:]))
                if p_auth_wait is not None:
                    p_auth_retry_attempt += 1
                    flight_recorder.crumb(session_id, "auth-resume", wait_s=p_auth_wait, err=str(p_result_err)[:160])
                    logger.warning(
                        f"Auth-shaped turn failure on session {session_id}; refreshing credentials and "
                        f"resuming once in {p_auth_wait}s. err={p_result_err!s}"
                    )
                    try:
                        from backend.apps.nine_router.subscription_health import invalidate_health_cache
                        invalidate_health_cache()
                    except Exception:
                        logger.debug("health-cache invalidate before auth resume failed", exc_info=True)
                    await p_finalize_interrupted_stream()
                    await asyncio.sleep(p_auth_wait)
                    p_stderr_buffer.clear()
                    if session.sdk_session_id:
                        options_kwargs["resume"] = session.sdk_session_id
                        options = ClaudeAgentOptions(**options_kwargs)
                    continue
                # Any other error-shaped result: the CLI already ran the whole turn (tools executed) and then reported failure; a resume-retry would re-execute side effects, so this goes straight to the error card.
                raise
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
                # Same auth twin as the TurnResultError branch: a 401 can also arrive as a raised
                # exception (ProcessError with the cause only in stderr). One refresh-and-resume,
                # on its own counter so it neither burns a capacity slot nor logs as transient.
                if wait is None:
                    p_auth_wait2 = auth_resume_wait(e, p_auth_retry_attempt, extra_text=stderr_snapshot)
                    if p_auth_wait2 is not None:
                        p_auth_retry_attempt += 1
                        flight_recorder.crumb(session_id, "auth-resume", wait_s=p_auth_wait2, err=str(e)[:160])
                        logger.warning(f"Auth-shaped exception on session {session_id}; refreshing and resuming once in {p_auth_wait2}s. exc={e!r}")
                        try:
                            from backend.apps.nine_router.subscription_health import invalidate_health_cache
                            invalidate_health_cache()
                        except Exception:
                            logger.debug("health-cache invalidate before auth resume failed", exc_info=True)
                        await p_finalize_interrupted_stream()
                        await asyncio.sleep(p_auth_wait2)
                        p_stderr_buffer.clear()
                        if session.sdk_session_id:
                            options_kwargs["resume"] = session.sdk_session_id
                            options = ClaudeAgentOptions(**options_kwargs)
                        continue
                if wait is not None:
                    capacity_retry_attempt += 1
                    flight_recorder.crumb(session_id, "transient-retry", attempt=capacity_retry_attempt, wait=wait, err=str(e)[:160])
                    mid_stream = turn.current_turn_emitted
                    logger.warning(
                        f"Transient upstream error on session {session_id} "
                        f"(attempt {capacity_retry_attempt}/{len(CAPACITY_BACKOFFS)}, "
                        f"mid_stream={mid_stream}); sleeping {wait}s before retry. "
                        f"exc={e!r} stderr_tail={stderr_snapshot[-400:]!r}"
                    )
                    await p_finalize_interrupted_stream()
                    await asyncio.sleep(wait)
                    p_stderr_buffer.clear()
                    if session.sdk_session_id:
                        options_kwargs["resume"] = session.sdk_session_id
                        options = ClaudeAgentOptions(**options_kwargs)
                    continue
                raise

