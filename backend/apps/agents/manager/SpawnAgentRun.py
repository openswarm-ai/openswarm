"""spawn_agent: back the SpawnAgent MCP tool with a FRESH sub-agent session (no history
copy; the prompt must be self-contained). Replaces the CLI's built-in Agent tool, which is
blocked in RunOptions: its subagent types resolve to models router setups can't serve, and
its schema drags description/subagent_type/model/isolation along. Mixin, same MRO pattern
as AgentLaunch."""

import asyncio
import logging
from datetime import datetime
from typing import Dict, List, Optional
from uuid import uuid4

from typeguard import typechecked

from backend.apps.agents.core.models import AgentSession, Message
from backend.apps.agents.core.ws_manager import ws_manager
from backend.apps.agents.manager.AgentManagerProtocol import AgentManagerProtocol
from backend.apps.agents.manager.session.apply_context_window import apply_context_window
from backend.apps.agents.manager.session.session_store import snapshot_session_now, load_session_data
from backend.apps.agents.manager.subagent_budget import (
    SUBAGENT_MAX_TURNS, budget_briefing, subagent_turn_budget,
)

logger = logging.getLogger(__name__)


# Eric's board, 2026-08-26: one parent spawned 21 transcription children and 14 died on the policy filter, each
# re-dispatched with a rephrased prompt because the return said only "No response from sub-agent."
DECLINED_CHILDREN_CAP = 2

DECLINED_REPLY = (
    "The sub-agent's request was declined by the model provider's filter before it finished. Sending the "
    "same task to another sub-agent will be declined too, so do not spawn another for it. Tell the user what "
    "was completed and what was declined, and let them decide."
)


@typechecked
def declined_children_this_turn(sessions: Dict[str, AgentSession], parent: AgentSession) -> List[AgentSession]:
    """Children of this parent that ended on the filter since the parent's last real message."""
    p_asks = [m.timestamp for m in parent.messages if m.role == "user" and not m.hidden]
    p_since = p_asks[-1] if p_asks else parent.created_at
    return [
        s for s in sessions.values()
        if s.parent_session_id == parent.id and s.last_failure_kind == "policy_block" and s.created_at >= p_since
    ]


@typechecked
def child_reply(child: AgentSession) -> str:
    if child.last_failure_kind == "policy_block":
        from backend.apps.agents.core.error_classify import neutralize_provider_refusal
        p_partial = neutralize_provider_refusal(last_assistant_text(child) or "")
        return DECLINED_REPLY + (f"\n\nIts last note before stopping: {p_partial}" if p_partial else "")
    return last_assistant_text(child) or "No response from sub-agent."


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

        p_declined = declined_children_this_turn(self.sessions, parent)
        if len(p_declined) >= DECLINED_CHILDREN_CAP:
            logger.warning(f"SpawnAgent refused for {parent_session_id}: {len(p_declined)} children declined by the filter this turn")
            return {"error": (
                f"{len(p_declined)} sub-agents for this task were declined by the model provider's filter this turn. "
                "Not spawning another: the same task will be declined again. Tell the user what was completed "
                "and what was declined, and let them decide."
            )}

        title = (prompt.strip().splitlines() or [""])[0][:60] or "Sub-agent"
        child = AgentSession(
            id=uuid4().hex,
            name=title,
            status="running",
            model=parent.model,
            mode="sub-agent",
            system_prompt=parent.system_prompt,
            allowed_tools=list(parent.allowed_tools),
            max_turns=subagent_turn_budget(parent.max_turns),
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
        snapshot_session_now(child)
        await ws_manager.send_to_session(child.id, "agent:message", {
            "session_id": child.id,
            "message": user_msg.model_dump(mode="json"),
        })

        # The child is told its step budget so it can checkpoint instead of being cut off mid-task
        # (ENG-409). Appended to what is SENT, not to the stored user message: the card should show
        # the task the parent asked for, not our bookkeeping.
        p_sent = f"{prompt}\n\n{budget_briefing(child.max_turns or SUBAGENT_MAX_TURNS)}"

        if run_in_background:
            # Fire-and-forget; the child's card carries its progress and result. Keep a handle in self.tasks so stop/shutdown machinery sees it.
            task = asyncio.create_task(self.run_agent_loop(child.id, p_sent))
            self.register_turn_task(child.id, task)
            return {"session_id": child.id, "background": True}

        await self.run_agent_loop(child.id, p_sent)
        return {
            "session_id": child.id,
            "status": child.status,
            "response": child_reply(child),
            "cost_usd": child.cost_usd,
        }
