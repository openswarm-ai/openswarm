"""Session-control operations for AgentManager (stop / approve / switch-branch / update),
split from Messaging so each file stays one responsibility: these control or mutate a
session WITHOUT producing a new agent turn. Pure relocation, self.* resolves across the MRO."""

import asyncio
import logging
from datetime import datetime
from typing import Dict

from typeguard import typechecked

from backend.apps.agents.core.ws_manager import ws_manager
from backend.apps.agents.manager.session.session_store import save_session

logger = logging.getLogger(__name__)


from backend.apps.agents.manager.AgentManagerProtocol import AgentManagerProtocol


class SessionControl(AgentManagerProtocol):
    @typechecked
    async def stop_agent(self, session_id: str):
        """Stop a running agent and all its browser-agent children."""
        # Stop children first so browser agents get cancelled before parent
        children = [
            s for s in self.sessions.values()
            if s.parent_session_id == session_id and s.mode == "browser-agent"
        ]
        for child in children:
            await self.stop_agent(child.id)

        session = self.sessions.get(session_id)
        if session:
            # Set cancel event BEFORE cancelling the task so in-flight browser agent loops see it immediately
            ev = self.cancel_events.get(session_id)
            if ev:
                ev.set()

            for req in list(session.pending_approvals):
                ws_manager.resolve_approval(req.id, {"behavior": "deny", "message": "Agent stopped"})
            session.pending_approvals = []

            session.status = "stopped"
            session.needs_fresh_session = True
            if not session.closed_at:
                session.closed_at = datetime.now()
            # Persist the partial reply NOW, before tearing down the SDK. The cancel handler also does this, but it sits behind the generator's teardown, which can take several seconds; doing it here means the streamed text stays put the instant Stop is pressed instead of blinking out and reappearing once teardown finishes.
            await self.commit_partial_now(session)
            await ws_manager.send_to_session(session_id, "agent:status", {
                "session_id": session_id,
                "status": "stopped",
                "session": session.model_dump(mode="json"),
            })
            # Snapshot now: the cancelled task's finally skips the save (it's no longer the live task once we pop it below), so persist the partial here or it'd live only in memory until the next turn / shutdown.
            try:
                save_session(session_id, session.model_dump(mode="json"))
            except Exception:
                pass

        # Drop the task from the registry immediately so a follow-up message isn't rejected as "still running" while the cancelled task slowly tears down (that window was eating user messages). Drain it in the background; we've already captured the partial above.
        task = self.tasks.pop(session_id, None)
        if task and not task.done():
            task.cancel()
            asyncio.create_task(self.drain_task(task))

    @typechecked
    def handle_approval(self, request_id: str, decision: Dict):
        """Resolve a pending HITL approval."""
        ws_manager.resolve_approval(request_id, decision)

    @typechecked
    async def switch_branch(self, session_id: str, branch_id: str):
        session = self.sessions.get(session_id)
        if not session:
            raise ValueError(f"Session {session_id} not found")
        if branch_id not in session.branches:
            raise ValueError(f"Branch {branch_id} not found")
        session.active_branch_id = branch_id
        session.needs_fresh_session = True
        await ws_manager.send_to_session(session_id, "agent:branch_switched", {
            "session_id": session_id,
            "active_branch_id": branch_id,
        })

    @typechecked
    async def update_session(self, session_id: str, **fields):
        """Update mutable session fields (system_prompt, name)."""
        session = self.sessions.get(session_id)
        if not session:
            raise ValueError(f"Session {session_id} not found")

        allowed = {"system_prompt", "name", "thinking_level"}
        for key, value in fields.items():
            if key in allowed:
                # Defend against bad thinking_level values
                if key == "thinking_level" and value not in ("off", "low", "medium", "high", "auto"):
                    continue
                setattr(session, key, value)

        await ws_manager.send_to_session(session_id, "agent:status", {
            "session_id": session_id,
            "status": session.status,
            "session": session.model_dump(mode="json"),
        })
