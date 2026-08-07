"""Post-conversation fact distillation: pull at most two durable USER facts from a session tail
and reconcile them into the memory store. Cost-gated (first at two user messages, then every six
more, once each), provider-agnostic cheap tier, fail-open to an empty list."""

import logging
from typing import Dict, List

from typeguard import typechecked

from backend.apps.agents.core.aux_llm import aux_max_tokens_for
from backend.apps.agents.core.models import AgentSession
from backend.apps.agents.manager.predict_followups import conversation_tail
from backend.apps.agents.manager.session.history_compaction import get_branch_messages
from backend.apps.memory.store import add_fact

logger = logging.getLogger(__name__)

MAX_FACTS_PER_DISTILL = 2
P_FIRST_AT = 2
P_EVERY = 6
# Session id -> user-message count at the last distill, so each threshold fires exactly once.
p_last_distilled: Dict[str, int] = {}


@typechecked
def p_user_message_count(session: AgentSession) -> int:
    return sum(1 for m in get_branch_messages(session) if m.role == "user" and not getattr(m, "hidden", False))


@typechecked
def distill_eligible(session: AgentSession) -> bool:
    users = p_user_message_count(session)
    if users < P_FIRST_AT:
        return False
    last = p_last_distilled.get(session.id, 0)
    return users >= (P_FIRST_AT if last == 0 else last + P_EVERY)


@typechecked
async def distill_session_memory(session: AgentSession) -> List[str]:
    """Facts added or updated this pass ([] on any miss). The store's reconcile dedupes repeats."""
    try:
        if not distill_eligible(session):
            return []
        from backend.apps.settings.credentials import get_anthropic_client_for_model
        from backend.apps.agents.providers.registry import resolve_aux_model
        from backend.apps.settings.settings import load_settings

        global_settings = load_settings()
        if not getattr(global_settings, "memory_enabled", True):
            return []
        tail = conversation_tail(session)
        if not tail:
            return []
        p_last_distilled[session.id] = p_user_message_count(session)
        aux_model = (await resolve_aux_model(global_settings, preferred_tier="haiku"))[0]
        client = get_anthropic_client_for_model(global_settings, aux_model)
        system_prompt = (
            "You extract durable facts about the USER from a conversation with their AI agent: "
            "who they are, what they work on, standing preferences, constraints they stated. "
            "Facts must be about the user themselves and still true next month; never task details, "
            "never one-off requests, never anything the ASSISTANT said, never secrets, keys, or "
            "passwords. Write each fact self-contained in third person, under 200 characters "
            '(e.g. "Prefers concise answers with real measured numbers").\n\n'
            f"Return at most {MAX_FACTS_PER_DISTILL} facts, one per line, no numbering, no quotes. "
            "If the conversation reveals nothing durable, return the single word NOTHING."
        )
        user_turn = "Conversation:\n<transcript>\n" + tail + "\n</transcript>\n\nExtract the facts."
        chunks: List[str] = []
        async with client.messages.stream(
            model=aux_model,
            max_tokens=aux_max_tokens_for(aux_model, base=200),
            system=system_prompt,
            messages=[{"role": "user", "content": user_turn}],
        ) as stream:
            async for text in stream.text_stream:
                chunks.append(text)
        added: List[str] = []
        for line in "".join(chunks).splitlines():
            line = line.strip().strip("-*• ").strip()
            if not line or len(line) < 8 or line.upper() == "NOTHING":
                continue
            fact = add_fact(line, source="distilled")
            if fact is not None:
                added.append(fact.text)
            if len(added) >= MAX_FACTS_PER_DISTILL:
                break
        return added
    except Exception as e:
        logger.info(f"[memory-distill] fail-open ([]): {e}")
        return []
