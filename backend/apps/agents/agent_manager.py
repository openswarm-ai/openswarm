import asyncio
import logging
import os
from contextlib import asynccontextmanager
from typing import AsyncIterator, Dict, List, Optional
from typeguard import typechecked

from backend.apps.agents.core.models import (
    AgentSession, Message,
)
from backend.apps.agents.core.ws_manager import ws_manager
from backend.apps.settings.settings import load_settings
from backend.apps.tools_lib.tools_lib import load_builtin_permissions
# SESSIONS_DIR is re-exported on purpose: session_store reads agent_manager.SESSIONS_DIR at call time (dodging a circular import), and the disk-resilience test monkeypatches it here.
from backend.config.paths import SESSIONS_DIR as SESSIONS_DIR
from backend.apps.agents.manager.session.session_store import (
    save_session,
    load_session_data as load_session_data,
)
from backend.apps.agents.manager.streaming.state import ThinkingState, TurnState
from backend.apps.agents.manager.streaming.PartialReply import PartialReply
from backend.apps.agents.manager.session.SessionLifecycle import SessionLifecycle
from backend.apps.agents.manager.session.SessionPersistence import SessionPersistence
from backend.apps.agents.manager.Messaging import Messaging
from backend.apps.agents.manager.SessionControl import SessionControl
from backend.apps.agents.manager.AgentLaunch import AgentLaunch
from backend.apps.agents.manager.MockAgent import MockAgent
from backend.apps.agents.manager.RunSupport import RunSupport
from backend.apps.agents.manager.run.handle_run_error import handle_run_error
from backend.apps.agents.manager.run.TurnRunner import TurnRunner
from backend.apps.agents.manager.run.RunOptions import RunOptions

logger = logging.getLogger(__name__)

os.environ.setdefault("CLAUDE_CODE_STREAM_CLOSE_TIMEOUT", "3600000")

# Cap concurrent ROOT agent turns so firing 30 agents at once doesn't spawn 30 CLIs in the same instant; the overflow queues (agents are model/IO-bound, so they're waiting anyway). Env-tunable, 0/blank disables the gate.
MAX_CONCURRENT_TURNS = int(os.environ.get("OSW_MAX_CONCURRENT_TURNS", "8") or "0")


class AgentManager(SessionLifecycle, SessionPersistence, Messaging, SessionControl, AgentLaunch, MockAgent, TurnRunner, RunOptions, RunSupport):
    @typechecked
    def __init__(self):
        self.sessions: Dict[str, AgentSession] = {}
        self.tasks: Dict[str, asyncio.Task] = {}
        # Live mirror of the in-flight streamed assistant text per session, so a stop can persist the partial reply instantly instead of waiting out the multi-second SDK teardown the cancel handler sits behind.
        self.live_partial: Dict[str, PartialReply] = {}
        # Per-session cancel signal: the loop stashes its asyncio.Event here so a stop/close can set it. Lives on the manager, not the AgentSession model, so it stays out of serialization (an Event can't be model_dump'd).
        self.cancel_events: Dict[str, asyncio.Event] = {}
        # Persistent-client pool (lever A, flag-gated): one live CLI per session, reused across turns.
        self.client_pool: Dict[str, object] = {}
        # Per-SESSION hook context + stderr buffer, updated in place each turn: a persistent client's hooks/stderr callback were bound at connect, so they must read stable objects, not per-turn rebuilds.
        self.hook_ctxs: Dict[str, object] = {}
        self.stderr_buffers: Dict[str, List[str]] = {}
        # Admission gate: one shared semaphore caps concurrent ROOT turns (children bypass). (Re)created per running loop by get_turn_admission so it never binds to a dead loop across a uvicorn reload or a test's asyncio.run.
        self.p_turn_admission_sema: Optional[asyncio.Semaphore] = None
        self.p_turn_admission_loop: Optional[asyncio.AbstractEventLoop] = None


    @typechecked
    def get_turn_admission(self) -> asyncio.Semaphore:
        """The shared admission semaphore for the CURRENT loop; rebuilt if the loop changed so a
        reload/test-run can never await a semaphore bound to a dead loop."""
        loop = asyncio.get_running_loop()
        if self.p_turn_admission_sema is None or self.p_turn_admission_loop is not loop:
            self.p_turn_admission_sema = asyncio.Semaphore(MAX_CONCURRENT_TURNS)
            self.p_turn_admission_loop = loop
        return self.p_turn_admission_sema

    @asynccontextmanager
    async def turn_admission_slot(self, session: AgentSession, session_id: str) -> AsyncIterator[None]:
        """Hold one concurrency slot for the duration of a ROOT turn. Overflow turns queue on the
        semaphore (emitting agent:queued, then agent:admitted when they start). Two bypasses, both
        load-bearing: (1) MAX_CONCURRENT_TURNS<=0 disables the gate entirely (kill switch); (2) a
        CHILD turn (parent_session_id set) is NEVER gated, because a parent holds its own slot while
        awaiting a delegated child, so gating children would deadlock the pool. `async with` release
        is cancellation-safe: a stop while queued never acquired, so it can't over-release."""
        if MAX_CONCURRENT_TURNS <= 0 or session.parent_session_id is not None:
            yield
            return
        sema = self.get_turn_admission()
        was_queued = sema.locked()
        if was_queued:
            try:
                await ws_manager.send_to_session(session_id, "agent:queued", {"session_id": session_id})
            except Exception:
                pass
        async with sema:
            if was_queued:
                try:
                    await ws_manager.send_to_session(session_id, "agent:admitted", {"session_id": session_id})
                except Exception:
                    pass
            yield

    @typechecked
    async def run_agent_loop(self, session_id: str, prompt: str, images: Optional[List] = None, context_paths: Optional[List] = None, forced_tools: Optional[List[str]] = None, attached_skills: Optional[List] = None, fork_session: bool = False, selected_browser_ids: Optional[List[str]] = None, selected_app_output_ids: Optional[List[str]] = None, selected_setting_ids: Optional[List[str]] = None, context_valve_retry: bool = False):
        """Run the Claude Agent SDK query loop for a session."""
        session = self.sessions.get(session_id)
        if not session:
            return

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
        turn = TurnState()
        p_stderr_buffer: List[str] = []
        # Read BEFORE build_agent_options consumes these flags: a fresh-session/fork request must force the persistent client to respawn (same branch id would otherwise fingerprint-match a client still holding the old transcript).
        p_force_respawn = bool(session.needs_fresh_session or session.needs_fork or fork_session)
        try:
            (options, options_kwargs, prompt_content, p_stderr_buffer,
             global_settings) = await self.build_agent_options(
                session, session_id, prompt, prompt_content, builtin_perms,
                selected_browser_ids, selected_app_output_ids, selected_setting_ids,
                fork_session, p_router_model_id, p_api_type_for_session)
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
            from backend.apps.agents.core.error_classify import is_context_pressure_death
            p_stderr_tail = "\n".join(p_stderr_buffer[-50:])
            if not context_valve_retry and is_context_pressure_death(e, turn.compact_boundaries, extra_text=p_stderr_tail):
                # Pressure-release valve: the CLI compacted this turn and still died (its "autocompact is thrashing" giving-up class). Its resume transcript is beyond saving, but ours isn't: rebuild from the local mirror via the proven fresh-session recap path and transparently re-run the turn ONCE.
                logger.warning(
                    f"Agent {session_id}: context-pressure death after "
                    f"{turn.compact_boundaries} compact boundaries; one fresh-session recap retry"
                )
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
                    from backend.apps.agents.core.error_classify import redact_for_telemetry
                    submit_diagnostic({
                        "kind": "context_pressure_valve",
                        "session_id": session_id,
                        "model": session.model,
                        "compact_boundaries": turn.compact_boundaries,
                        "error_preview": redact_for_telemetry(str(e), limit=300),
                    })
                except Exception:
                    logger.debug("submit_diagnostic context_pressure_valve failed", exc_info=True)
                await self.run_agent_loop(
                    session_id, prompt, images, context_paths, forced_tools,
                    attached_skills, fork_session, selected_browser_ids,
                    selected_app_output_ids, selected_setting_ids,
                    context_valve_retry=True,
                )
                return
            await handle_run_error(e, session, session_id, turn, p_stderr_buffer)
        except BaseException as e:
            # Catch BaseExceptionGroup from anyio task groups (e.g. concurrent CLI crash + pending approval cancellation) so it doesn't escape and kill the uvicorn process.
            logger.exception(f"Agent {session_id} fatal error: {e}")
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


agent_manager = AgentManager()
