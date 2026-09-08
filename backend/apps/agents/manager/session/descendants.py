"""Every session born from a parent, whatever kind it is. Stop, close and delete used to walk only
browser-agent children, so a SpawnAgent tree outlived the parent that was killed (Haik, exp.9)."""

from typing import Dict, List

from typeguard import typechecked

from backend.apps.agents.core.models import AgentSession


@typechecked
def children_of(sessions: Dict[str, AgentSession], parent_id: str) -> List[AgentSession]:
    return [s for s in sessions.values() if s.parent_session_id == parent_id]
