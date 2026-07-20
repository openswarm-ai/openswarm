"""spawn_agent: back the SpawnAgent MCP tool with a FRESH sub-agent session (no history
copy; the prompt must be self-contained). Replaces the CLI's built-in Agent tool, which is
blocked in RunOptions: its subagent types resolve to models router setups can't serve, and
its schema drags description/subagent_type/model/isolation along. Mixin, same MRO pattern
as AgentLaunch."""

import asyncio
import logging
from datetime import datetime
from typing import Dict, Optional
from uuid import uuid4

from typeguard import typechecked

from backend.apps.agents.core.models import AgentSession, Message
from backend.apps.agents.core.ws_manager import ws_manager
from backend.apps.agents.manager.AgentManagerProtocol import AgentManagerProtocol
from backend.apps.agents.manager.session.apply_context_window import apply_context_window
from backend.apps.agents.manager.session.session_store import load_session_data

logger = logging.getLogger(__name__)


def last_assistant_text(session: AgentSession) -> Optional[str]:
    for msg in reversed(session.messages):
        if msg.role == "assistant":
            content = msg.content
            if isinstance(content, str):
                return content
            if isinstance(content, list):
                texts = [b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text"]
                return "\n".join(texts)
            return str(content)
    return None


class SpawnAgentRun(AgentManagerProtocol):
    @typechecked
    async def spawn_agent(
        self,
        prompt: str,
        parent_session_id: str,
        dashboard_id: Optional[str] = None,
        run_in_background: bool = False,
    ) -> Dict:
        parent = self.sessions.get(parent_session_id)
        if not parent:
            data = load_session_data(parent_session_id)
            if data is None:
                raise ValueError(f"Parent session {parent_session_id} not found")
            parent = AgentSession(**data)

        title = (prompt.strip().splitlines() or [""])[0][:60] or "Sub-agent"
        child = AgentSession(
            id=uuid4().hex,
            name=title,
            status="running",
            model=parent.model,
            mode="sub-agent",
            system_prompt=parent.system_prompt,
            allowed_tools=list(parent.allowed_tools),
            max_turns=parent.max_turns or 25,
            cwd=parent.cwd,
            created_at=datetime.now(),
            dashboard_id=dashboard_id or parent.dashboard_id,
            parent_session_id=parent_session_id,
        )
        apply_context_window(child)
        self.sessions[child.id] = child

        await ws_manager.broadcast_global("agent:status", {
            "session_id": child.id,
            "status": child.status,
            "session": child.model_dump(mode="json"),
        })

        user_msg = Message(
            role="user",
            content=prompt,
            branch_id=child.active_branch_id,
        )
        child.messages.append(user_msg)
        await ws_manager.send_to_session(child.id, "agent:message", {
            "session_id": child.id,
            "message": user_msg.model_dump(mode="json"),
        })

        if run_in_background:
            # Fire-and-forget; the child's card carries its progress and result. Keep a handle in self.tasks so stop/shutdown machinery sees it.
            task = asyncio.create_task(self.run_agent_loop(child.id, prompt))
            self.tasks[child.id] = task
            return {"session_id": child.id, "background": True}

        await self.run_agent_loop(child.id, prompt)
        return {
            "session_id": child.id,
            "response": last_assistant_text(child) or "No response from sub-agent.",
            "cost_usd": child.cost_usd,
        }
