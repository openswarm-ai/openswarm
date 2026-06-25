import asyncio
import logging
import os
from typing import Dict, List, Optional
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


class AgentManager(SessionLifecycle, SessionPersistence, Messaging, SessionControl, AgentLaunch, MockAgent, TurnRunner, RunOptions, RunSupport):
    @typechecked
    def __init__(self):
        self.sessions: Dict[str, AgentSession] = {}
        self.tasks: Dict[str, asyncio.Task] = {}
        # Live mirror of the in-flight streamed assistant text per session, so a stop can persist the partial reply instantly instead of waiting out the multi-second SDK teardown the cancel handler sits behind.
        self.live_partial: Dict[str, PartialReply] = {}
        # Per-session cancel signal: the loop stashes its asyncio.Event here so a stop/close can set it. Lives on the manager, not the AgentSession model, so it stays out of serialization (an Event can't be model_dump'd).
        self.cancel_events: Dict[str, asyncio.Event] = {}


    @typechecked
    async def run_agent_loop(self, session_id: str, prompt: str, images: Optional[List] = None, context_paths: Optional[List] = None, forced_tools: Optional[List[str]] = None, attached_skills: Optional[List] = None, fork_session: bool = False, selected_browser_ids: Optional[List[str]] = None, selected_app_output_ids: Optional[List[str]] = None, selected_setting_ids: Optional[List[str]] = None):
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
        try:
            (options, options_kwargs, prompt_content, p_stderr_buffer,
             global_settings) = await self.build_agent_options(
                session, session_id, prompt, prompt_content, builtin_perms,
                selected_browser_ids, selected_app_output_ids, selected_setting_ids,
                fork_session, p_router_model_id, p_api_type_for_session)
            resolved_model = p_router_model_id
            api_type = p_api_type_for_session

            thinking = ThinkingState()
            await self.run_turn_with_retry(
                session, session_id, prompt_content, options, options_kwargs,
                turn, thinking, p_stderr_buffer, resolved_model, api_type, global_settings,
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
