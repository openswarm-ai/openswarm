"""Turn-producing message operations for AgentManager (send + queue), the ones that append a
user Message and spawn the agent loop. Editing a prior message lives in EditMessage; session-control
ops (stop / approve / branch / update) live in SessionControl. Pure relocation: self.* resolves across the MRO as before."""

import asyncio
import logging
from typing import List, Optional

from pydantic import BaseModel, ConfigDict
from typeguard import typechecked

from backend.apps.agents.core.models import AgentSession, Message
from backend.apps.agents.core.ws_manager import ws_manager
from backend.apps.settings.settings import load_settings
from backend.apps.agents.manager.run_browser_fast_path import run_browser_fast_path
from backend.apps.agents.manager.session.session_store import snapshot_session_now, load_session_data
from backend.apps.agents.manager.session.apply_context_window import apply_context_window
from backend.apps.agents.manager.prompt.tool_catalog import get_all_tool_names
from backend.apps.agents.manager.prompt.prompt_context import resolve_mode

logger = logging.getLogger(__name__)



from backend.apps.agents.manager.AgentManagerProtocol import AgentManagerProtocol


class QueuedMessage(BaseModel):
    """A user message that arrived while a turn was live, held until that turn ends.
    Carries the full send_message argument set so delivery is a faithful replay."""

    model_config = ConfigDict(validate_assignment=True)

    prompt: str
    mode: Optional[str] = None
    model: Optional[str] = None
    provider: Optional[str] = None
    images: Optional[List] = None
    context_paths: Optional[List] = None
    forced_tools: Optional[List[str]] = None
    attached_skills: Optional[List] = None
    hidden: bool = False
    selected_browser_ids: Optional[List[str]] = None
    selected_app_output_ids: Optional[List[str]] = None
    selected_setting_ids: Optional[List[str]] = None
    client_message_id: Optional[str] = None


class Messaging(AgentManagerProtocol):
    @typechecked
    async def send_message(
        self,
        session_id: str,
        prompt: str,
        mode: Optional[str] = None,
        model: Optional[str] = None,
        provider: Optional[str] = None,
        images: Optional[List] = None,
        context_paths: Optional[List] = None,
        forced_tools: Optional[List[str]] = None,
        attached_skills: Optional[List] = None,
        hidden: bool = False,
        by_user: bool = False,
        selected_browser_ids: Optional[List[str]] = None,
        selected_app_output_ids: Optional[List[str]] = None,
        selected_setting_ids: Optional[List[str]] = None,
        client_message_id: Optional[str] = None,
    ):
        """Send a follow-up message to an existing session."""
        session = self.sessions.get(session_id)
        if not session:
            data = load_session_data(session_id)
            if data:
                session = AgentSession(**data)
                # This disk reload (and the closed_at wipe below) is how a late watchdog retry reopened a card the user had closed; a MACHINE send must not revive it (a human's own Resume click carries by_user and may).
                if hidden and not by_user and session.ended_by_user:
                    return
                apply_context_window(session)
                session.closed_at = None
                self.sessions[session_id] = session
            else:
                raise ValueError(f"Session {session_id} not found")
        # Every automatic resume arrives hidden; a human's Stop or close outranks all of them. `hidden` only means "do not render a user bubble", so the Resume chip's own click is hidden too and used to be swallowed here, leaving the chip to reappear forever (Eric, live, 2026-08-21). Authorship is what this guard cares about, so it asks by_user.
        if hidden and not by_user and session.ended_by_user:
            return
        if session.ended_by_user and (not hidden or by_user):
            session.ended_by_user = False

        existing = self.tasks.get(session_id)
        if existing and not existing.done():
            # A mid-turn message used to be silently dropped here (no bubble, no trace); queue it and the turn task's done callback replays it.
            self.pending_messages.setdefault(session_id, []).append(QueuedMessage(
                prompt=prompt, mode=mode, model=model, provider=provider, images=images,
                context_paths=context_paths, forced_tools=forced_tools,
                attached_skills=attached_skills, hidden=hidden,
                selected_browser_ids=selected_browser_ids,
                selected_app_output_ids=selected_app_output_ids,
                selected_setting_ids=selected_setting_ids,
                client_message_id=client_message_id,
            ))
            return

        session_changed = False
        if model and model != session.model:
            # Cross-provider model switches force a session fork. The CLI's resume transcript stores Anthropic-format content blocks with Anthropic tool_use_ids; replaying them on a non-Anthropic provider via 9Router's claude→openai translator corrupts history silently (fixMissingToolResponses stubs missing tool responses with placeholder text). Forking starts a new CLI session so history is re-sent fresh in whichever format the new provider expects.
            from backend.apps.agents.providers.registry import get_api_type as get_api_type_for_model
            if get_api_type_for_model(session.model) != get_api_type_for_model(model):
                session.needs_fork = True
                logger.info(f"[MCP-DEBUG] Forking session: api_type changed {session.model}→{model}")

            session.model = model
            apply_context_window(session)
            session_changed = True
        if mode and mode != session.mode:
            session.mode = mode
            mode_tools, _, _ = resolve_mode(mode, get_all_tool_names)
            session.allowed_tools = mode_tools
            session_changed = True
        if session_changed:
            await ws_manager.send_to_session(session_id, "agent:status", {
                "session_id": session_id,
                "status": session.status,
                "session": session.model_dump(mode="json"),
            })

        # Hidden messages (nudges, lost-step retries, auth heals) go out verbatim: the attribution prefix they used to carry (ENG-326) announced harness traffic on the subscription lane, whose provider filter blocks exactly that (Eric's call, 2026-08-21); honesty about who is speaking lives in the nudge texts themselves.
        skill_meta = [{"id": s["id"], "name": s["name"]} for s in (attached_skills or [])] or None
        image_meta = [{"data": img["data"], "media_type": img.get("media_type", "image/png")} for img in (images or [])] or None
        user_msg = Message(
            role="user",
            content=prompt,
            branch_id=session.active_branch_id,
            context_paths=context_paths if context_paths else None,
            attached_skills=skill_meta,
            forced_tools=forced_tools if forced_tools else None,
            images=image_meta,
            hidden=hidden,
            client_message_id=client_message_id,
        )
        session.messages.append(user_msg)
        # Status flips BEFORE the snapshot: the old order persisted a stale "completed" from the
        # prior turn, so a dirty death during a follow-up turn was invisible to the boot-time crash
        # detector (drilled live: round-2 kill -9 resumed nothing because disk said completed).
        session.status = "running"
        snapshot_session_now(session)
        await ws_manager.send_to_session(session_id, "agent:message", {
            "session_id": session_id,
            "message": user_msg.model_dump(mode="json"),
        })

        # A real user message opens a fresh silent-quit budget; the cap only guards within one ask.
        if not hidden:
            # A human actively driving the session forgives its crash history (breaker reset).
            session.crash_interrupt_count = 0
            session.empty_finish_nudges = 0
            session.empty_finish_progress_mark = 0
            session.empty_finish_surfaced = False
            session.auth_retry_used = False
            # The repeat-quit floor and the vanishing-quit rule key on this; one false positive used to arm both for the session's life (ENG-364).
            session.empty_finish_total = 0
            # The borrowed API key was for one ask, and this is a new one; back to the lane they chose.
            if session.lane_failover_from:
                logger.info(f"lane failover over for {session_id}: {session.model} -> {session.lane_failover_from}")
                session.model = session.lane_failover_from
                session.lane_failover_from = None
            # A human is here and driving, so an earlier outage stops counting against the next one.
            session.reconnect_attempts = 0
            session.awaiting_reconnect = False
        # Fire a background aux LLM call to generate a 3-6 word verb-phrase describing this turn ("Auditing the pull request", "Drafting your email"). The narrator pill swaps from its heuristic verb to this label as soon as it lands, usually ~500ms-1s into the turn, which is exactly when "Thinking…" starts feeling generic. Provider-agnostic via resolve_aux_model. Non-blocking; failure is silent and the heuristic stays.
        if not hidden and prompt:
            try:
                asyncio.create_task(
                    self.generate_turn_label(session_id, user_msg.id, prompt)
                )
            except Exception:
                pass

        is_first_message = sum(1 for m in session.messages if m.role == "user") == 1

        session.status = "running"
        await ws_manager.send_to_session(session_id, "agent:status", {
            "session_id": session_id,
            "status": "running",
            "session": session.model_dump(mode="json"),
        })

        # Browser fast path: a plainly browser-only first message skips the orchestrator LLM entirely (it was ~2/3 of the token bill on these tasks, spent deciding "delegate to a browser" and restating the outcome). Conservative gates + a cheap aux classifier; any miss or error falls through to the normal loop.
        fast_verdict = "no"
        fast_brief = ""
        if not hidden:
            try:
                from backend.apps.agents.browser import browser_fast_path
                extras = bool(images or context_paths or forced_tools or attached_skills
                               or len(selected_browser_ids or []) > 1)
                if browser_fast_path.fast_path_eligible(
                    prompt, session.mode or "", session.dashboard_id, is_first_message, extras,
                ):
                    from backend.apps.agents.providers.registry import get_api_type
                    fast_verdict, fast_brief = await browser_fast_path.classify_and_brief(
                        prompt, load_settings(), get_api_type(session.model),
                    )
            except Exception as e:
                logger.warning(f"[browser-fast-path] gate error, normal path: {e}")

        if fast_verdict != "no":
            task = asyncio.create_task(run_browser_fast_path(session, session_id, prompt, selected_browser_ids, fast_brief, fast_verdict))
        else:
            task = asyncio.create_task(self.run_agent_loop(session_id, prompt, images=images, context_paths=context_paths, forced_tools=forced_tools, attached_skills=attached_skills, selected_browser_ids=selected_browser_ids, selected_app_output_ids=selected_app_output_ids, selected_setting_ids=selected_setting_ids))
        self.register_turn_task(session_id, task)

    @typechecked
    def register_turn_task(self, session_id: str, task: asyncio.Task) -> None:
        """One chokepoint for installing a turn task: every turn end (success, error, stop)
        fires the done callback, so a queued mid-turn message can never strand."""
        self.tasks[session_id] = task
        task.add_done_callback(lambda t: self.deliver_next_queued_message(session_id))

    @typechecked
    def deliver_next_queued_message(self, session_id: str) -> None:
        """Replay the oldest queued mid-turn message once no turn is live. One at a time:
        the delivered turn's own done callback drains the rest."""
        queue = self.pending_messages.get(session_id)
        if not queue:
            return
        live = self.tasks.get(session_id)
        if live and not live.done():
            return
        qm = queue.pop(0)
        if not queue:
            self.pending_messages.pop(session_id, None)
        asyncio.create_task(self.send_message(
            session_id, qm.prompt, mode=qm.mode, model=qm.model, provider=qm.provider,
            images=qm.images, context_paths=qm.context_paths, forced_tools=qm.forced_tools,
            attached_skills=qm.attached_skills, hidden=qm.hidden,
            selected_browser_ids=qm.selected_browser_ids,
            selected_app_output_ids=qm.selected_app_output_ids,
            selected_setting_ids=qm.selected_setting_ids,
            client_message_id=qm.client_message_id,
        ))
