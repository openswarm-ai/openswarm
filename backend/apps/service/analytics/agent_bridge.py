"""Bridge a broadcast `agent:message` into the typed `events.agent.message`.

Called from ws_manager.send_to_session, the single chokepoint every agent message
flows through. Best-effort: never raises into the broadcast path.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict
from typeguard import typechecked

from backend.apps.agents.core.models import AgentSession
from backend.apps.service.analytics.client import track_agent_message

logger = logging.getLogger(__name__)


class BroadcastMessage(BaseModel):
    # An agent:message broadcast payload, validated at the WS boundary; extra fields ignored.
    model_config = ConfigDict(validate_assignment=True, extra="ignore")
    id: Optional[str] = None
    role: Optional[str] = None
    content: Any = None
    parent_id: Optional[str] = None
    branch_id: Optional[str] = None


@typechecked
def p_branch_version(session: AgentSession, message: BroadcastMessage) -> int:
    # Edit marker for branch_id: only the message that CREATED a forked branch (the actual edit) scores non-zero; replies and new turns reset to 0.
    branch_str = message.branch_id or "main"
    branches = getattr(session, "branches", None) or {}
    b = branches.get(branch_str)
    fork_point = getattr(b, "fork_point_message_id", None) if b else None
    if not fork_point:
        return 0
    branch_user_msgs = [
        m for m in (getattr(session, "messages", None) or [])
        if getattr(m, "branch_id", None) == branch_str and getattr(m, "role", None) == "user"
    ]
    if not branch_user_msgs or getattr(branch_user_msgs[0], "id", None) != message.id:
        return 0
    siblings = sorted(
        (x for x in branches.values()
         if getattr(x, "fork_point_message_id", None) == fork_point),
        key=lambda x: x.created_at,
    )
    for i, x in enumerate(siblings, start=1):
        if x.id == branch_str:
            return i
    return 0


@typechecked
def bridge_agent_message(session_id: str, message: BroadcastMessage) -> None:
    # seq is the message's stable index in the persisted history (survives close -> reopen -> restart); transient messages with no anchor are skipped.
    if not message.id or not message.role:
        return
    try:
        from backend.apps.agents.agent_manager import agent_manager
        sess = agent_manager.sessions.get(session_id)
    except Exception:
        sess = None
    if sess is None:
        return
    msgs = getattr(sess, "messages", None) or []
    seq = next((i for i, m in enumerate(msgs) if getattr(m, "id", None) == message.id), None)
    if seq is None:
        return
    track_agent_message(
        agent_id=session_id,
        seq=seq,
        id=str(message.id),
        role=str(message.role),
        content=message.content,
        parent_id=message.parent_id,
        branch_id=p_branch_version(sess, message),
        provider=getattr(sess, "provider", None),
        model=getattr(sess, "model", None),
        thinking_level=getattr(sess, "thinking_level", None),
    )
