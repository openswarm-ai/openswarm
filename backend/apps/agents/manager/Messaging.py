"""Turn-producing message operations for AgentManager (send + edit), the ones that append a
user Message and spawn the agent loop. Session-control ops (stop / approve / branch / update)
live in SessionControl. Pure relocation: self.* resolves across the MRO as before."""

import asyncio
import logging
from typing import List, Optional

from typeguard import typechecked
from uuid import uuid4

from backend.apps.agents.core.models import AgentSession, Message, MessageBranch
from backend.apps.agents.core.ws_manager import ws_manager
from backend.apps.settings.settings import load_settings
from backend.apps.agents.manager.run_browser_fast_path import run_browser_fast_path
from backend.apps.agents.manager.session.session_store import load_session_data
from backend.apps.agents.manager.session.apply_context_window import apply_context_window
from backend.apps.agents.manager.prompt.tool_catalog import get_all_tool_names
from backend.apps.agents.manager.prompt.prompt_context import resolve_mode

logger = logging.getLogger(__name__)


from backend.apps.agents.manager.AgentManagerProtocol import AgentManagerProtocol


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
                apply_context_window(session)
                session.closed_at = None
                self.sessions[session_id] = session
            else:
                raise ValueError(f"Session {session_id} not found")
        
        existing = self.tasks.get(session_id)
        if existing and not existing.done():
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
        await ws_manager.send_to_session(session_id, "agent:message", {
            "session_id": session_id,
            "message": user_msg.model_dump(mode="json"),
        })

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
        self.tasks[session_id] = task

    @typechecked
    async def edit_message(self, session_id: str, message_id: str, new_content: str):
        """Edit a prior user message, creating a new branch (fork)."""
        session = self.sessions.get(session_id)
        if not session:
            raise ValueError(f"Session {session_id} not found")

        existing = self.tasks.get(session_id)
        if existing and not existing.done():
            existing.cancel()
            try:
                await existing
            except asyncio.CancelledError:
                pass

        target_msg = None
        for i, msg in enumerate(session.messages):
            if msg.id == message_id:
                target_msg = msg
                break

        if not target_msg or target_msg.role != "user":
            raise ValueError("Can only edit user messages")

        fork_point_id = message_id
        fork_parent_branch = target_msg.branch_id

        msg_branch = session.branches.get(target_msg.branch_id)
        if msg_branch and msg_branch.fork_point_message_id:
            branch_user_msgs = [
                m for m in session.messages
                if m.branch_id == target_msg.branch_id and m.role == "user"
            ]
            if branch_user_msgs and branch_user_msgs[0].id == message_id:
                fork_point_id = msg_branch.fork_point_message_id
                fork_parent_branch = msg_branch.parent_branch_id or "main"

        new_branch_id = uuid4().hex
        new_branch = MessageBranch(
            id=new_branch_id,
            parent_branch_id=fork_parent_branch,
            fork_point_message_id=fork_point_id,
        )
        session.branches[new_branch_id] = new_branch
        session.active_branch_id = new_branch_id
        session.needs_fresh_session = True


        edited_msg = Message(
            role="user",
            content=new_content,
            branch_id=new_branch_id,
            parent_id=target_msg.parent_id,
            images=target_msg.images,
            context_paths=target_msg.context_paths,
            forced_tools=target_msg.forced_tools,
            attached_skills=target_msg.attached_skills,
        )
        session.messages.append(edited_msg)

        await ws_manager.send_to_session(session_id, "agent:message", {
            "session_id": session_id,
            "message": edited_msg.model_dump(mode="json"),
        })
        await ws_manager.send_to_session(session_id, "agent:branch_created", {
            "session_id": session_id,
            "branch": new_branch.model_dump(mode="json"),
            "active_branch_id": new_branch_id,
        })

        session.status = "running"
        await ws_manager.send_to_session(session_id, "agent:status", {
            "session_id": session_id,
            "status": "running",
            "session": session.model_dump(mode="json"),
        })

        task = asyncio.create_task(self.run_agent_loop(
            session_id, new_content,
            images=target_msg.images,
            context_paths=target_msg.context_paths,
            forced_tools=target_msg.forced_tools,
            attached_skills=target_msg.attached_skills,
            fork_session=True,
        ))
        self.tasks[session_id] = task

