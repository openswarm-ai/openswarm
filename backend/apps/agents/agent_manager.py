import asyncio
import logging
import time
import os
from typing import Any, Dict, List, Optional
from typeguard import typechecked

from backend.apps.agents.core.models import Message
from backend.apps.agents.core.ws_manager import ws_manager
from backend.apps.settings.settings import load_settings
from backend.apps.tools_lib.tools_lib import load_builtin_permissions
# SESSIONS_DIR is re-exported on purpose: session_store reads agent_manager.SESSIONS_DIR at call time (dodging a circular import), and the disk-resilience test monkeypatches it here.
from backend.config.paths import SESSIONS_DIR as SESSIONS_DIR
from backend.apps.agents.manager.session.session_store import (
    save_session,
    load_session_data as load_session_data,
)
from backend.apps.agents.manager.session.SessionStore import SessionStore
from backend.apps.agents.manager.streaming.state import ThinkingState, TurnState
from backend.apps.agents.manager.session.SessionLifecycle import SessionLifecycle
from backend.apps.agents.manager.SpawnAgentRun import SpawnAgentRun
from backend.apps.agents.manager.session.SessionPersistence import SessionPersistence
from backend.apps.agents.manager.Messaging import Messaging, QueuedMessage
from backend.apps.agents.manager.SessionControl import SessionControl
from backend.apps.agents.manager.AgentLaunch import AgentLaunch
from backend.apps.agents.manager.MockAgent import MockAgent
from backend.apps.agents.manager.RunSupport import RunSupport
from backend.apps.agents.manager.run.handle_run_error import handle_run_error
from backend.apps.agents.manager.run.TurnRunner import TurnRunner
from backend.apps.agents.manager.run.TurnAdmission import TurnAdmission
from backend.apps.agents.manager.run.RunOptions import RunOptions
from backend.apps.agents.events.AgentEventSink import (
    AgentEventSink,
    BoundedAgentEventSink,
    NullAgentEventSink,
)
from backend.apps.agents.events.AgentTurnEventEmitter import AgentTurnEventEmitter

logger = logging.getLogger(__name__)

os.environ.setdefault("CLAUDE_CODE_STREAM_CLOSE_TIMEOUT", "3600000")

class AgentManager(SessionLifecycle, SessionPersistence, Messaging, SessionControl, AgentLaunch, SpawnAgentRun, MockAgent, TurnAdmission, TurnRunner, RunOptions, RunSupport):
    @typechecked
    def __init__(self, store: Optional[SessionStore] = None, event_sink: Optional[AgentEventSink] = None):
        self.store = store or SessionStore()
        self.event_sink = event_sink or NullAgentEventSink()
        # Messages queued behind an in-flight turn (upstream admission/queue); purged per session in SessionLifecycle.purge_session_memory.
        self.pending_messages: Dict[str, List[QueuedMessage]] = {}
        from backend.apps.agents.core.flight_recorder import set_sessions_provider
        set_sessions_provider(lambda: self.sessions)
        # Admission gate: one shared semaphore caps concurrent ROOT turns (children bypass). (Re)created per running loop by get_turn_admission so it never binds to a dead loop across a uvicorn reload or a test's asyncio.run.
        self.p_turn_admission_sema: Optional[asyncio.Semaphore] = None
        self.p_turn_admission_loop: Optional[asyncio.AbstractEventLoop] = None

    @property
    @typechecked
    def sessions(self) -> Dict[str, Any]:
        return self.store.sessions

    @sessions.setter
    @typechecked
    def sessions(self, value: Dict[str, Any]) -> None:
        object.__setattr__(self.store, "sessions", value)

    @property
    @typechecked
    def tasks(self) -> Dict[str, Any]:
        return self.store.tasks

    @tasks.setter
    @typechecked
    def tasks(self, value: Dict[str, Any]) -> None:
        object.__setattr__(self.store, "tasks", value)

    @property
    @typechecked
    def live_partial(self) -> Dict[str, Any]:
        return self.store.live_partial

    @live_partial.setter
    @typechecked
    def live_partial(self, value: Dict[str, Any]) -> None:
        object.__setattr__(self.store, "live_partial", value)

    @property
    @typechecked
    def cancel_events(self) -> Dict[str, asyncio.Event]:
        return self.store.cancel_events

    @cancel_events.setter
    @typechecked
    def cancel_events(self, value: Dict[str, asyncio.Event]) -> None:
        object.__setattr__(self.store, "cancel_events", value)

    @property
    @typechecked
    def client_pool(self) -> Dict[str, Any]:
        return self.store.client_pool

    @client_pool.setter
    @typechecked
    def client_pool(self, value: Dict[str, Any]) -> None:
        object.__setattr__(self.store, "client_pool", value)

    @property
    @typechecked
    def hook_ctxs(self) -> Dict[str, Any]:
        return self.store.hook_ctxs

    @hook_ctxs.setter
    @typechecked
    def hook_ctxs(self, value: Dict[str, Any]) -> None:
        object.__setattr__(self.store, "hook_ctxs", value)

    @property
    @typechecked
    def stderr_buffers(self) -> Dict[str, List[str]]:
        return self.store.stderr_buffers

    @stderr_buffers.setter
    @typechecked
    def stderr_buffers(self, value: Dict[str, List[str]]) -> None:
        object.__setattr__(self.store, "stderr_buffers", value)

    @typechecked
    async def ensure_keyed_model_route_synced(self, settings, short_name: str) -> None:
        """Ensure 9Router has the provider node required by a pinned API-key model."""
        from backend.apps.agents.providers.registry import find_builtin_model

        entry = find_builtin_model(short_name) or {}
        if entry.get("route") != "api":
            return

        provider = entry.get("api")
        if provider == "openai" and getattr(settings, "openai_api_key", None):
            from backend.apps import nine_router
            if not nine_router.is_running():
                await nine_router.ensure_running()
            if nine_router.is_running():
                await nine_router.sync_openai_api_key(settings.openai_api_key)
        elif provider == "gemini" and getattr(settings, "google_api_key", None):
            from backend.apps import nine_router
            if not nine_router.is_running():
                await nine_router.ensure_running()
            if nine_router.is_running():
                await nine_router.sync_gemini_api_key(settings.google_api_key)
        elif provider == "custom" and getattr(settings, "custom_providers", None):
            from backend.apps import nine_router
            if not nine_router.is_running():
                await nine_router.ensure_running()
            if nine_router.is_running():
                await nine_router.sync_custom_providers(settings.custom_providers or [])


    @typechecked
    async def prewarm_client(self, session_id: str) -> None:
        """Spawn the session's CLI in the seconds between create and the first message, so the first
        turn's acquire is a pool hit instead of a 0.6-1.6s cold connect. Best-effort: any failure
        just means the first turn pays the connect it always paid. Kill switch OSW_PREWARM_CLI=0."""
        if os.environ.get("OSW_PREWARM_CLI", "1") == "0":
            return
        session = self.sessions.get(session_id)
        if not session or session.messages:
            return
        try:
            import claude_agent_sdk  # noqa: F401
        except ImportError:
            return
        try:
            from backend.apps.agents.providers.registry import (
                resolve_model_id_for_sdk as p_resolve,
                get_api_type as p_api_of,
            )
            p_router_model_id = p_resolve(session.model, load_settings())
            p_api_type = p_api_of(session.model)
            builtin_perms = load_builtin_permissions()
            # Representative-LENGTH prompt: thinking derives from prompt length (<50 chars forces it
            # off), so an empty prewarm prompt would boot a different thinking config than a typical
            # first message and fingerprint-miss into a respawn. 50+ chars matches the common case.
            p_representative = "prewarm placeholder prompt of representative length for boot"
            (options, options_kwargs, _, _, _) = await self.build_agent_options(
                session, session_id, p_representative, "", builtin_perms,
                None, None, None, False, p_router_model_id, p_api_type)
            from claude_agent_sdk import ClaudeSDKClient
            from backend.apps.agents.manager.run.client_pool import acquire_client, boot_fingerprint

            async def p_connect():
                p_client = ClaudeSDKClient(options=options)
                logger.info(f"[SPAWN-PHASE] prewarm-connect start session={session_id[:8]} t={time.monotonic():.3f}")
                await p_client.connect()
                logger.info(f"[SPAWN-PHASE] prewarm-connect done session={session_id[:8]} t={time.monotonic():.3f}")
                return p_client

            fp = boot_fingerprint(options_kwargs, session)
            await acquire_client(self.client_pool, session_id, fp, p_connect)
            # Deleted mid-connect: the late-arriving client just pooled into a dead session; nothing else will ever dispose it.
            if session_id not in self.sessions:
                from backend.apps.agents.manager.run.client_pool import dispose_client
                await dispose_client(self.client_pool, session_id)
        except Exception:
            logger.info("[client-pool] prewarm skipped for %s", session_id[:8], exc_info=True)

    @typechecked
    async def run_agent_loop(self, session_id: str, prompt: str, images: Optional[List] = None, context_paths: Optional[List] = None, forced_tools: Optional[List[str]] = None, attached_skills: Optional[List] = None, fork_session: bool = False, selected_browser_ids: Optional[List[str]] = None, selected_app_output_ids: Optional[List[str]] = None, selected_setting_ids: Optional[List[str]] = None, context_valve_retry: bool = False):
        """Run the Claude Agent SDK query loop for a session."""
        session = self.sessions.get(session_id)
        if not session:
            return

        self.ensure_session_workspace_ready(session)

        from backend.apps.agents.providers.registry import get_api_type as p_get_api_type
        p_api = p_get_api_type(session.model)
        prompt_content = self.build_prompt_content(
            prompt, images, context_paths, forced_tools, attached_skills,
            api_type=p_api, model=session.model,
        )

        try:
            # SDK presence check: fall to mock mode here, before the options build, so a missing SDK is a clean mock run, not an error card. The real use is in run_options / turn_runner (lazy-imported there).
            import claude_agent_sdk  # noqa: F401
        except ImportError:
            logger.warning("claude_agent_sdk not installed, running in mock mode")
            await self.run_mock_agent(session_id, prompt)
            return

        session.status = "running"

        # Resolve the model id now so every closure (approval hook, tool executed handler, etc.) has both the short name and the 9Router-prefixed id available without re-resolving. The short name is what the user sees; the router id is what 9Router reports its per-model counters under.
        from backend.apps.agents.providers.registry import (
            resolve_model_id_for_sdk as p_resolve_model_id_early,
            get_api_type as p_get_api_type_early,
        )
        p_router_model_id = p_resolve_model_id_early(session.model, load_settings())
        p_api_type_for_session = p_get_api_type_early(session.model)

        builtin_perms = load_builtin_permissions()

        # Builtins default to always_allow (frictionless); path_gate still force-prompts on catastrophic patterns (rm -rf), OS-scheduling, and sensitive paths, so poisoned-email -> destructive-command is still caught. Flip Bash to "ask" in the UI for a prompt on every command. Bind turn + stderr first: build_agent_options can raise early (no provider) and the except hands both to handle_run_error.
        p_stderr_buffer: List[str] = []
        # Read BEFORE build_agent_options consumes these flags: a fresh-session/fork request must force the persistent client to respawn (same branch id would otherwise fingerprint-match a client still holding the old transcript).
        p_force_respawn = bool(session.needs_fresh_session or session.needs_fork or fork_session)
        p_event_emitter = AgentTurnEventEmitter(
            sink=self.event_sink,
            session_id=session_id,
            provider=p_api_type_for_session,
            model=p_router_model_id,
        )
        turn = TurnState(event_emitter=p_event_emitter)
        p_event_emitter.emit_started()
        try:
            logger.info(f"[SPAWN-PHASE] run-loop start session={session_id[:8]} t={time.monotonic():.3f}")
            (options, options_kwargs, prompt_content, p_stderr_buffer,
             global_settings) = await self.build_agent_options(
                session, session_id, prompt, prompt_content, builtin_perms,
                selected_browser_ids, selected_app_output_ids, selected_setting_ids,
                fork_session, p_router_model_id, p_api_type_for_session)
            p_hook_ctx = self.hook_ctxs.get(session_id)
            if p_hook_ctx is not None:
                p_hook_ctx.event_emitter = p_event_emitter
            resolved_model = p_router_model_id
            api_type = p_api_type_for_session

            thinking = ThinkingState()
            # Gate the CLI turn (spawn + stream) behind the admission slot so a burst can't run every turn at once; the slot is held ONLY for run_turn_with_retry, so the context-valve retry below re-acquires cleanly instead of nesting.
            async with self.turn_admission_slot(session, session_id):
                await self.run_turn_with_retry(
                    session, session_id, prompt_content, options, options_kwargs,
                    turn, thinking, p_stderr_buffer, resolved_model, api_type, global_settings,
                    force_respawn=p_force_respawn,
                )
            session.status = "completed"
            p_event_emitter.emit_completed(
                input_tokens=int(session.tokens.get("input_fresh", 0) or 0),
                output_tokens=int(session.tokens.get("output", 0) or 0),
            )

            # Silent-quit seal: a turn that ran tools and ended with no visible answer gets ONE hidden continue nudge (dispatched by the auto-continuation block below); a second silent quit in the same ask surfaces as-is rather than looping.
            try:
                from backend.apps.agents.manager.run.empty_finish import maybe_nudge_empty_finish
                maybe_nudge_empty_finish(session, session_id)
            except Exception:
                logger.exception("empty-finish detection failed; continuing")

            # Auto-continuation hook (Phase 3). If MCPActivate (or any analogous flow) flagged pending_continuation during this turn, kick off a follow-up turn immediately with the captured prompt. We dispatch as a fire-and-forget task so the current run_agent_loop frame can unwind cleanly before the next turn's options + history rebuild kicks in. The follow-up is `hidden=True` so it doesn't add a user bubble to the visible chat; the model sees it as a synthetic prompt to keep working.
            try:
                if getattr(session, "pending_continuation", False):
                    p_continuation_prompt = session.pending_continuation_prompt or "Continue."
                    session.pending_continuation = False
                    session.pending_continuation_prompt = None
                    asyncio.create_task(self.send_message(
                        session_id,
                        p_continuation_prompt,
                        hidden=True,
                    ))
                    logger.info(f"Auto-continuing session {session_id} with hidden prompt")
            except Exception:
                logger.exception("auto-continuation dispatch failed")
        except asyncio.CancelledError:
            p_event_emitter.emit_failed("cancelled")
            # Only act if we're still the session's live task. A user stop pops this task (stop_agent already finalized status + partial), and a follow-up message may have started a newer turn; either way this dying task must NOT clobber the live status or pop the new turn's in-flight partial mirror.
            if self.tasks.get(session_id) is asyncio.current_task():
                session.status = "stopped"
                # A cancelled turn desyncs the CLI's resume transcript from session.messages (the SDK never recorded the interrupted turn), so force the next turn to rebuild history from session.messages, else resume/follow-ups replay a transcript with no trace of the stopped reply ("nothing to continue").
                session.needs_fresh_session = True
                # Persist whatever streamed before the cancel (edit / branch switch paths; the user-stop path already did this in stop_agent).
                await self.commit_partial_now(session)
            turn.stream_text_msg_id = None
            turn.stream_text_accum = ""
        except Exception as e:
            from backend.apps.agents.core.error_classify import is_context_overflow_error, is_context_pressure_death
            p_stderr_tail = "\n".join(p_stderr_buffer[-50:])
            p_overflow = is_context_overflow_error(e, extra_text=p_stderr_tail)
            if not context_valve_retry and (p_overflow or is_context_pressure_death(e, turn.compact_boundaries, extra_text=p_stderr_tail)):
                # Pressure-release valve, two entry shapes: the CLI compacted this turn and still died (autocompact thrash), or the provider rejected the query outright as over the context window. Either way the CLI's resume transcript is beyond saving, but ours isn't: rebuild from the local mirror via the proven fresh-session recap path and transparently re-run the turn ONCE.
                logger.warning(
                    f"Agent {session_id}: {'context overflow' if p_overflow else 'context-pressure death'} after "
                    f"{turn.compact_boundaries} compact boundaries; one fresh-session recap retry"
                )
                # The recap rebuild trims at compacted_through_msg_id; an overflow can hit before the proactive threshold ever fired, so force a cutoff or the rebuilt prompt is full history again.
                self.maybe_compact(session, force=True)
                session.needs_fresh_session = True
                if turn.stream_text_msg_id:
                    await ws_manager.send_to_session(session_id, "agent:stream_end", {
                        "session_id": session_id,
                        "message_id": turn.stream_text_msg_id,
                    })
                for p_tool_msg_id in turn.stream_tool_msg_ids_ordered:
                    await ws_manager.send_to_session(session_id, "agent:stream_end", {
                        "session_id": session_id,
                        "message_id": p_tool_msg_id,
                    })
                self.live_partial.pop(session_id, None)
                # Tell the user we self-healed instead of retrying in silence: the frontend renders this as a muted transient pill (same language as the rate-limit pill), not an error card.
                try:
                    await ws_manager.send_to_session(session_id, "agent:context_recovered", {
                        "session_id": session_id,
                    })
                except Exception:
                    logger.debug("context_recovered broadcast failed", exc_info=True)
                try:
                    from backend.apps.service.client import submit_diagnostic
                    from backend.apps.agents.core.redact_for_telemetry import redact_for_telemetry
                    from backend.apps.agents.core import flight_recorder as p_fr
                    submit_diagnostic({
                        "kind": "context_pressure_valve",
                        "trigger": "overflow" if p_overflow else "pressure_death",
                        "flight": p_fr.build_envelope(session_id, "context_pressure_valve", "overflow" if p_overflow else "pressure_death", session.model, "stream", turn.compact_boundaries),
                        "session_id": session_id,
                        "model": session.model,
                        "compact_boundaries": turn.compact_boundaries,
                        "error_preview": redact_for_telemetry(str(e), limit=300),
                    })
                except Exception:
                    logger.debug("submit_diagnostic context_pressure_valve failed", exc_info=True)
                p_event_emitter.emit_failed("context_pressure_retry", retryable=True)
                await self.run_agent_loop(
                    session_id, prompt, images, context_paths, forced_tools,
                    attached_skills, fork_session, selected_browser_ids,
                    selected_app_output_ids, selected_setting_ids,
                    context_valve_retry=True,
                )
                return
            p_event_emitter.emit_failed(type(e).__name__)
            await handle_run_error(e, session, session_id, turn, p_stderr_buffer)
        except BaseException as e:
            # Catch BaseExceptionGroup from anyio task groups (e.g. concurrent CLI crash + pending approval cancellation) so it doesn't escape and kill the uvicorn process.
            logger.exception(f"Agent {session_id} fatal error: {e}")
            p_event_emitter.emit_failed(type(e).__name__)
            # A group's str() names the group, not the cause; unwrap to the real member so a wrapped 429/auth error still gets its friendly card + retry-pill semantics.
            from backend.apps.agents.core.first_real_exception import first_real_exception
            p_real = first_real_exception(e)
            if p_real is not None:
                await handle_run_error(p_real, session, session_id, turn, p_stderr_buffer)
                return
            session.status = "error"
            error_msg = Message(role="system", content=f"Error: {str(e)}", branch_id=session.active_branch_id)
            session.messages.append(error_msg)
            await ws_manager.send_to_session(session_id, "agent:message", {
                "session_id": session_id,
                "message": error_msg.model_dump(mode="json"),
            })
        finally:
            # Only the session's live task finalizes. A stopped task (popped by stop_agent, which already finalized status + saved) or one superseded by a newer turn must not pop the new turn's partial mirror, broadcast a stale terminal status, or overwrite the snapshot the live turn is writing.
            p_is_live_task = self.tasks.get(session_id) is asyncio.current_task()
            if p_is_live_task:
                self.live_partial.pop(session_id, None)
            if session_id in self.sessions and p_is_live_task:
                # For canvas-launched App Builder sessions, the workspace folder IS the session_id (see launch_agent), so meta.json lives at outputs_workspace/<session_id>/meta.json. Read it and propagate name/description into the Output row before the terminal status fires; without this, the row stays "Untitled App" forever because no React component polls the file on the canvas path. Best-effort, only acts when the row's name is still the default placeholder.
                if session.mode == "view-builder":
                    try:
                        from backend.apps.outputs.outputs import sync_output_from_meta_json
                        from backend.apps.outputs.workspace_io import load_all as load_outputs
                        if sync_output_from_meta_json(session_id, fallback_name=session.name):
                            # Broadcast the renamed row so the sidebar flips from "Untitled App" to the real name without waiting for the next mount.
                            try:
                                matching = [o for o in load_outputs() if o.workspace_id == session_id]
                                if matching:
                                    await ws_manager.broadcast_global("agent:output_upserted", {
                                        "output": matching[0].model_dump(mode="json"),
                                    })
                            except Exception:
                                logger.exception("post-sync output_upserted broadcast failed")
                    except Exception:
                        logger.exception("post-session meta sync failed")
                await ws_manager.send_to_session(session_id, "agent:status", {
                    "session_id": session_id,
                    "status": session.status,
                    "session": session.model_dump(mode="json"),
                })
                try:
                    save_session(session_id, session.model_dump(mode="json"))
                except Exception as e:
                    logger.warning(f"Failed to snapshot session {session_id}: {e}")


agent_manager = AgentManager(event_sink=BoundedAgentEventSink())
