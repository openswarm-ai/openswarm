"""Thin coordinator for agent sessions.

Heavy logic lives in sibling modules:
- prompt_builder   – system-prompt composition & context injection
- mcp_builder      – MCP server construction & tool-policy helpers
- session_store    – on-disk persistence, history, message copying
- agent_loop       – the SDK query loop, streaming, mock agent
"""

from __future__ import annotations

import asyncio
import logging
import os
from datetime import datetime
from typing import Optional
from uuid import uuid4

from backend.apps.agents.models import (
    AgentConfig, AgentSession, Message, MessageBranch, ApprovalRequest, ToolGroupMeta,
)
from backend.apps.agents.ws_manager import ws_manager
from backend.apps.agents.prompt_builder import resolve_mode
from backend.apps.agents.mcp_builder import get_all_tool_names
from backend.apps.agents.session_store import (
    save_session, load_session_data, delete_session_file,
    load_all_session_data, build_search_text, get_history,
    reconcile_on_startup, get_browser_agent_children,
    copy_session_messages,
)
from backend.apps.agents.agent_loop import (
    run_agent_loop, fire_session_completed,
)
from backend.apps.settings.settings import load_settings
from backend.apps.common.llm_helpers import quick_llm_call, quick_llm_json
from backend.apps.analytics.collector import record as _analytics

logger = logging.getLogger(__name__)

os.environ.setdefault("CLAUDE_CODE_STREAM_CLOSE_TIMEOUT", "3600000")


class AgentManager:
    def __init__(self):
        self.sessions: dict[str, AgentSession] = {}
        self.tasks: dict[str, asyncio.Task] = {}

    # ------------------------------------------------------------------
    # Session lifecycle
    # ------------------------------------------------------------------

    async def launch_agent(self, config: AgentConfig) -> AgentSession:
        session_id = uuid4().hex
        mode_tools, _, mode_folder = resolve_mode(config.mode, get_all_tool_names)
        global_settings = load_settings()
        effective_cwd = (
            config.target_directory or mode_folder
            or global_settings.default_folder or os.path.expanduser("~")
        )
        if config.mode in ("view-builder", "skill-builder") and not config.target_directory:
            effective_cwd = os.path.join(effective_cwd, session_id)
        os.makedirs(effective_cwd, exist_ok=True)

        session = AgentSession(
            id=session_id, name=config.name,
            provider=getattr(config, "provider", "anthropic"),
            model=config.model, mode=config.mode,
            system_prompt=config.system_prompt, allowed_tools=mode_tools,
            max_turns=config.max_turns, cwd=effective_cwd,
            dashboard_id=config.dashboard_id,
        )
        self.sessions[session_id] = session
        _analytics("session.started", {
            "model": session.model, "provider": session.provider,
            "mode": session.mode, "tool_count": len(mode_tools),
        }, session_id=session_id, dashboard_id=config.dashboard_id)
        await ws_manager.send_to_session(session_id, "agent:status", {
            "session_id": session_id, "status": "running",
            "session": session.model_dump(mode="json"),
        })
        return session

    async def send_message(
        self, session_id: str, prompt: str,
        mode: str | None = None, model: str | None = None,
        provider: str | None = None, images: list | None = None,
        context_paths: list | None = None, forced_tools: list[str] | None = None,
        attached_skills: list | None = None, hidden: bool = False,
        selected_browser_ids: list[str] | None = None,
    ):
        session = self.sessions.get(session_id)
        if not session:
            raise ValueError(f"Session {session_id} not found")
        existing = self.tasks.get(session_id)
        if existing and not existing.done():
            return

        session_changed = False
        if model and model != session.model:
            _analytics("model.switched", {
                "from_model": session.model, "to_model": model,
                "from_provider": session.provider, "to_provider": provider or session.provider,
                "message_number": len([m for m in session.messages if m.role == "user"]),
                "cost_so_far": session.cost_usd,
            }, session_id=session_id, dashboard_id=session.dashboard_id)
            session.model = model
            session_changed = True
        if mode and mode != session.mode:
            _analytics("feature.used", {"feature": "mode.switched", "from_mode": session.mode, "to_mode": mode}, session_id=session_id, dashboard_id=session.dashboard_id)
            session.mode = mode
            mode_tools, _, _ = resolve_mode(mode, get_all_tool_names)
            session.allowed_tools = mode_tools
            session_changed = True
        if session_changed:
            await ws_manager.send_to_session(session_id, "agent:status", {
                "session_id": session_id, "status": session.status,
                "session": session.model_dump(mode="json"),
            })

        skill_meta = [{"id": s["id"], "name": s["name"]} for s in (attached_skills or [])] or None
        image_meta = [{"data": img["data"], "media_type": img.get("media_type", "image/png")} for img in (images or [])] or None
        user_msg = Message(
            role="user", content=prompt, branch_id=session.active_branch_id,
            context_paths=context_paths or None, attached_skills=skill_meta,
            forced_tools=forced_tools or None, images=image_meta, hidden=hidden,
        )
        session.messages.append(user_msg)
        await ws_manager.send_to_session(session_id, "agent:message", {
            "session_id": session_id, "message": user_msg.model_dump(mode="json"),
        })
        if context_paths or attached_skills or images or forced_tools:
            _analytics("context.attached", {
                "file_count": len([c for c in (context_paths or []) if c.get("type") == "file"]),
                "directory_count": len([c for c in (context_paths or []) if c.get("type") == "directory"]),
                "skill_count": len(attached_skills or []), "image_count": len(images or []),
                "has_forced_tools": bool(forced_tools),
            }, session_id=session_id, dashboard_id=session.dashboard_id)
        for skill in (attached_skills or []):
            _analytics("feature.used", {"feature": "skill.used", "skill_name": skill.get("name", "")}, session_id=session_id, dashboard_id=session.dashboard_id)
        is_first = sum(1 for m in session.messages if m.role == "user") == 1
        if is_first:
            _analytics("session.first_message", {
                "message_length": len(prompt), "has_code_block": "```" in prompt,
                "has_url": "http://" in prompt or "https://" in prompt,
                "model": session.model, "mode": session.mode,
            }, session_id=session_id, dashboard_id=session.dashboard_id)

        session.status = "running"
        await ws_manager.send_to_session(session_id, "agent:status", {
            "session_id": session_id, "status": "running",
            "session": session.model_dump(mode="json"),
        })
        task = asyncio.create_task(run_agent_loop(
            self.sessions, session_id, prompt, images=images,
            context_paths=context_paths, forced_tools=forced_tools,
            attached_skills=attached_skills, selected_browser_ids=selected_browser_ids,
        ))
        self.tasks[session_id] = task

    async def stop_agent(self, session_id: str):
        task = self.tasks.get(session_id)
        if task and not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        session = self.sessions.get(session_id)
        if session:
            for req in list(session.pending_approvals):
                ws_manager.resolve_approval(req.id, {"behavior": "deny", "message": "Agent stopped"})
            session.pending_approvals = []
            if hasattr(session, '_cancel_event'):
                session._cancel_event.set()
            session.status = "stopped"
            if not session.closed_at:
                session.closed_at = datetime.now()
            await ws_manager.send_to_session(session_id, "agent:status", {
                "session_id": session_id, "status": "stopped",
                "session": session.model_dump(mode="json"),
            })
        children = [s for s in self.sessions.values() if s.parent_session_id == session_id and s.mode == "browser-agent"]
        for child in children:
            await self.stop_agent(child.id)

    def handle_approval(self, request_id: str, decision: dict):
        ws_manager.resolve_approval(request_id, decision)

    async def edit_message(self, session_id: str, message_id: str, new_content: str):
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

        target_msg = next((m for m in session.messages if m.id == message_id), None)
        if not target_msg or target_msg.role != "user":
            raise ValueError("Can only edit user messages")

        fork_point_id = message_id
        fork_parent_branch = target_msg.branch_id
        msg_branch = session.branches.get(target_msg.branch_id)
        if msg_branch and msg_branch.fork_point_message_id:
            branch_user_msgs = [m for m in session.messages if m.branch_id == target_msg.branch_id and m.role == "user"]
            if branch_user_msgs and branch_user_msgs[0].id == message_id:
                fork_point_id = msg_branch.fork_point_message_id
                fork_parent_branch = msg_branch.parent_branch_id or "main"

        new_branch_id = uuid4().hex
        new_branch = MessageBranch(id=new_branch_id, parent_branch_id=fork_parent_branch, fork_point_message_id=fork_point_id)
        session.branches[new_branch_id] = new_branch
        session.active_branch_id = new_branch_id
        _analytics("feature.used", {
            "feature": "message.branched",
            "branch_depth": len([b for b in session.branches.values() if b.parent_branch_id]),
            "total_branches_in_session": len(session.branches),
            "messages_before_fork": len([m for m in session.messages if m.branch_id == fork_parent_branch]),
        }, session_id=session_id, dashboard_id=session.dashboard_id)

        edited_msg = Message(
            role="user", content=new_content, branch_id=new_branch_id,
            parent_id=target_msg.parent_id, images=target_msg.images,
            context_paths=target_msg.context_paths, forced_tools=target_msg.forced_tools,
            attached_skills=target_msg.attached_skills,
        )
        session.messages.append(edited_msg)
        await ws_manager.send_to_session(session_id, "agent:message", {"session_id": session_id, "message": edited_msg.model_dump(mode="json")})
        await ws_manager.send_to_session(session_id, "agent:branch_created", {"session_id": session_id, "branch": new_branch.model_dump(mode="json"), "active_branch_id": new_branch_id})
        session.sdk_session_id = None
        session.status = "running"
        await ws_manager.send_to_session(session_id, "agent:status", {"session_id": session_id, "status": "running", "session": session.model_dump(mode="json")})
        task = asyncio.create_task(run_agent_loop(
            self.sessions, session_id, new_content,
            images=target_msg.images, context_paths=target_msg.context_paths,
            forced_tools=target_msg.forced_tools, attached_skills=target_msg.attached_skills,
        ))
        self.tasks[session_id] = task

    async def switch_branch(self, session_id: str, branch_id: str):
        session = self.sessions.get(session_id)
        if not session:
            raise ValueError(f"Session {session_id} not found")
        if branch_id not in session.branches:
            raise ValueError(f"Branch {branch_id} not found")
        session.active_branch_id = branch_id
        await ws_manager.send_to_session(session_id, "agent:branch_switched", {"session_id": session_id, "active_branch_id": branch_id})

    # ------------------------------------------------------------------
    # LLM-powered metadata
    # ------------------------------------------------------------------

    async def generate_title(self, session_id: str, first_prompt: str) -> str:
        session = self.sessions.get(session_id)
        if not session:
            raise ValueError(f"Session {session_id} not found")
        title = first_prompt[:40].strip()
        try:
            title = await quick_llm_call(
                "Generate a concise 3-6 word title for a chat that starts with this message. Return only the title, nothing else.",
                first_prompt, max_tokens=30,
            )
            title = title.strip('"\'') or first_prompt[:40].strip()
        except Exception as e:
            logger.warning(f"Title generation failed, using fallback: {e}")
        session.name = title
        await ws_manager.send_to_session(session_id, "agent:name_updated", {"session_id": session_id, "name": title})
        return title

    async def generate_group_meta(self, session_id: str, group_id: str, tool_calls: list[dict], results_summary: list[str] | None = None, is_refinement: bool = False) -> dict:
        session = self.sessions.get(session_id)
        if not session:
            raise ValueError(f"Session {session_id} not found")
        fallback_name = tool_calls[0].get("tool", "Tool calls") if tool_calls else "Tool calls"
        fallback_name = fallback_name.split("__")[-1].replace("_", " ").title() if "__" in fallback_name else fallback_name
        name, svg = fallback_name, ""
        try:
            tool_desc = "\n".join(f"- {tc.get('tool', '?')}: {tc.get('input_summary', '')}" for tc in tool_calls)
            user_content = f"Tool actions:\n{tool_desc}"
            if results_summary:
                user_content += "\n\nResults:\n" + "\n".join(f"- {r}" for r in results_summary)
            system = (
                "Generate a concise 2-5 word name and a minimal SVG icon for a group of tool actions.\n\n"
                "Return ONLY valid JSON: {\"name\": \"...\", \"svg\": \"...\"}\n\n"
                "Name rules:\n- 2-5 words, title case, describes the action\n\n"
                "SVG rules:\n- 24x24 viewBox\n- Use currentColor for all stroke/fill\n"
                "- Simple geometric shapes only\n- No text, no images, no gradients\n"
                "- Max 400 characters for the svg string"
            )
            parsed = await quick_llm_json(system, user_content)
            if parsed.get("name"):
                name = parsed["name"].strip().strip("\"'")
            if parsed.get("svg"):
                svg = parsed["svg"].strip()
        except Exception as e:
            logger.warning(f"Group meta generation failed, using fallback: {e}")

        meta = ToolGroupMeta(id=group_id, name=name, svg=svg, is_refined=is_refinement)
        session.tool_group_meta[group_id] = meta
        await ws_manager.send_to_session(session_id, "agent:group_meta_updated", {
            "session_id": session_id, "group_id": group_id,
            "name": name, "svg": svg, "is_refined": is_refinement,
        })
        return {"name": name, "svg": svg, "is_refined": is_refinement}

    # ------------------------------------------------------------------
    # Session management
    # ------------------------------------------------------------------

    async def update_session(self, session_id: str, **fields):
        session = self.sessions.get(session_id)
        if not session:
            raise ValueError(f"Session {session_id} not found")
        for key, value in fields.items():
            if key in {"system_prompt", "name"}:
                setattr(session, key, value)
        await ws_manager.send_to_session(session_id, "agent:status", {
            "session_id": session_id, "status": session.status,
            "session": session.model_dump(mode="json"),
        })

    async def close_session(self, session_id: str) -> None:
        children = [s for s in self.sessions.values() if s.parent_session_id == session_id and s.mode == "browser-agent"]
        for child in children:
            await self.stop_agent(child.id)
        task = self.tasks.get(session_id)
        if task and not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        session = self.sessions.get(session_id)
        if not session:
            raise ValueError(f"Session {session_id} not found")
        if session.status in ("running", "waiting_approval"):
            session.status = "stopped"
        session.closed_at = datetime.now()
        for req in list(session.pending_approvals):
            ws_manager.resolve_approval(req.id, {"behavior": "deny", "message": "Session closed"})
        session.pending_approvals = []
        if hasattr(session, '_cancel_event'):
            session._cancel_event.set()
        fire_session_completed(session, self.sessions)
        doc_data = session.model_dump(mode="json")
        doc_data["search_text"] = build_search_text(session)
        save_session(session_id, doc_data)
        await ws_manager.send_to_session(session_id, "agent:closed", {
            "session_id": session_id, "status": session.status,
            "name": session.name, "model": session.model, "mode": session.mode,
            "created_at": session.created_at.isoformat() if session.created_at else None,
            "closed_at": session.closed_at.isoformat() if session.closed_at else None,
            "cost_usd": session.cost_usd, "dashboard_id": session.dashboard_id,
        })
        self.sessions.pop(session_id, None)
        self.tasks.pop(session_id, None)
        logger.info(f"Session {session_id} closed and persisted")

    async def delete_session(self, session_id: str) -> None:
        children = [s for s in self.sessions.values() if s.parent_session_id == session_id and s.mode == "browser-agent"]
        for child in children:
            await self.stop_agent(child.id)
        task = self.tasks.get(session_id)
        if task and not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        self.sessions.pop(session_id, None)
        self.tasks.pop(session_id, None)
        delete_session_file(session_id)
        logger.info(f"Session {session_id} permanently deleted")

    async def resume_session(self, session_id: str) -> AgentSession:
        if session_id in self.sessions:
            return self.sessions[session_id]
        data = load_session_data(session_id)
        if data is None:
            raise ValueError(f"Session {session_id} not found in history")
        session = AgentSession(**data)
        hours_since = 0
        if data.get("closed_at"):
            try:
                closed = datetime.fromisoformat(data["closed_at"][:19])
                hours_since = round((datetime.now() - closed).total_seconds() / 3600, 1)
            except Exception:
                pass
        _analytics("session.resumed", {
            "hours_since_closed": hours_since,
            "original_message_count": len(data.get("messages", [])),
            "original_cost_usd": data.get("cost_usd", 0), "model": session.model,
        }, session_id=session_id, dashboard_id=session.dashboard_id)
        session.closed_at = None
        self.sessions[session_id] = session
        delete_session_file(session_id)
        await ws_manager.send_to_session(session_id, "agent:status", {
            "session_id": session_id, "status": session.status,
            "session": session.model_dump(mode="json"),
        })
        logger.info(f"Session {session_id} resumed from history")
        return session

    async def duplicate_session(self, session_id: str, dashboard_id: str | None = None, up_to_message_id: str | None = None) -> AgentSession:
        source = self.sessions.get(session_id)
        if not source:
            data = load_session_data(session_id)
            if data is None:
                raise ValueError(f"Session {session_id} not found")
            source = AgentSession(**data)
        new_messages, new_branches, _ = copy_session_messages(source, up_to_message_id)
        new_session = AgentSession(
            id=uuid4().hex, name=f"{source.name} (copy)", status="stopped",
            model=source.model, mode=source.mode, system_prompt=source.system_prompt,
            allowed_tools=list(source.allowed_tools), max_turns=source.max_turns,
            cwd=source.cwd, created_at=datetime.now(), messages=new_messages,
            branches=new_branches, active_branch_id=source.active_branch_id,
            tool_group_meta=dict(source.tool_group_meta),
            dashboard_id=dashboard_id or source.dashboard_id,
        )
        self.sessions[new_session.id] = new_session
        await ws_manager.send_to_session(new_session.id, "agent:status", {
            "session_id": new_session.id, "status": new_session.status,
            "session": new_session.model_dump(mode="json"),
        })
        return new_session

    async def invoke_agent(self, source_session_id: str, message: str, parent_session_id: str | None = None, dashboard_id: str | None = None) -> dict:
        source = self.sessions.get(source_session_id)
        if not source:
            data = load_session_data(source_session_id)
            if data is None:
                raise ValueError(f"Session {source_session_id} not found")
            source = AgentSession(**data)
        source_name = source.name
        new_messages, new_branches, _ = copy_session_messages(source)
        fork = AgentSession(
            id=uuid4().hex, name=f"{source_name} (invoked)", status="running",
            model=source.model, mode="invoked-agent", sdk_session_id=source.sdk_session_id,
            system_prompt=source.system_prompt, allowed_tools=list(source.allowed_tools),
            max_turns=source.max_turns or 25, cwd=source.cwd, created_at=datetime.now(),
            messages=new_messages, branches=new_branches,
            active_branch_id=source.active_branch_id,
            tool_group_meta=dict(source.tool_group_meta),
            dashboard_id=dashboard_id or source.dashboard_id,
            parent_session_id=parent_session_id,
        )
        self.sessions[fork.id] = fork
        await ws_manager.broadcast_global("agent:status", {
            "session_id": fork.id, "status": fork.status,
            "session": fork.model_dump(mode="json"),
        })
        user_msg = Message(role="user", content=message, branch_id=fork.active_branch_id)
        fork.messages.append(user_msg)
        await ws_manager.send_to_session(fork.id, "agent:message", {
            "session_id": fork.id, "message": user_msg.model_dump(mode="json"),
        })
        await run_agent_loop(self.sessions, fork.id, message, fork_session=True)
        last_assistant = None
        for msg in reversed(fork.messages):
            if msg.role == "assistant":
                content = msg.content
                if isinstance(content, str):
                    last_assistant = content
                elif isinstance(content, list):
                    texts = [b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text"]
                    last_assistant = "\n".join(texts)
                else:
                    last_assistant = str(content)
                break
        return {
            "forked_session_id": fork.id, "source_name": source_name,
            "response": last_assistant or "No response from invoked agent.",
            "cost_usd": fork.cost_usd,
        }

    # ------------------------------------------------------------------
    # Queries
    # ------------------------------------------------------------------

    def get_all_sessions(self, dashboard_id: str | None = None) -> list[AgentSession]:
        if dashboard_id:
            return [s for s in self.sessions.values() if s.dashboard_id == dashboard_id]
        return list(self.sessions.values())

    def get_session(self, session_id: str) -> Optional[AgentSession]:
        return self.sessions.get(session_id)

    # ------------------------------------------------------------------
    # Delegated helpers (kept as methods for API compatibility)
    # ------------------------------------------------------------------

    def get_history(self, q: str = "", limit: int = 20, offset: int = 0, dashboard_id: str | None = None) -> dict:
        return get_history(q=q, limit=limit, offset=offset, dashboard_id=dashboard_id)

    async def reconcile_on_startup(self) -> None:
        return await reconcile_on_startup()

    async def persist_all_sessions(self) -> None:
        for session_id, session in list(self.sessions.items()):
            if session.status in ("running", "waiting_approval"):
                session.status = "stopped"
            for req in list(session.pending_approvals):
                ws_manager.resolve_approval(req.id, {"behavior": "deny", "message": "Server shutting down"})
            session.pending_approvals = []
            fire_session_completed(session, self.sessions)
            doc_data = session.model_dump(mode="json")
            doc_data["search_text"] = build_search_text(session)
            save_session(session_id, doc_data)
            logger.info(f"Persisted session {session_id} on shutdown")
        self.sessions.clear()
        self.tasks.clear()

    async def restore_all_sessions(self) -> None:
        for sid, data in load_all_session_data():
            try:
                session = AgentSession(**data)
            except Exception as e:
                logger.warning(f"Skipping corrupt session file {sid}: {e}")
                continue
            if session.closed_at is not None:
                continue
            if session.status in ("running", "waiting_approval"):
                session.status = "stopped"
            session.pending_approvals = []
            self.sessions[session.id] = session
            delete_session_file(sid)
            logger.info(f"Restored session {session.id}")

    def get_browser_agent_children(self, parent_session_id: str) -> list[dict]:
        return get_browser_agent_children(self.sessions, parent_session_id)


agent_manager = AgentManager()
