from typeguard import typechecked
from backend.core.Agent.Agent import Agent
from typing import List


@typechecked
def build_search_text(agent: Agent, max_len: int = 5000) -> str:
    parts: List[str] = []
    for msg in agent.messages.messages:
        if msg.role in ("user", "assistant") and isinstance(msg.content, str):
            parts.append(msg.content)
    return " ".join(parts)[:max_len]
