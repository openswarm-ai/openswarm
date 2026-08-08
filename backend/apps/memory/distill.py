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
from backend.apps.memory import store
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
        # Deliberately harsh. The permissive version filled a real user's memory with task summaries
        # ("works on an app with Slack OAuth, fullscreen modes, pinch-to-zoom") and topic echoes
        # ("interested in AI agents") that were just the last thing they happened to ask about. Saying
        # NOTHING costs nothing; a junk fact is paid for on every turn of every chat, forever.
        system_prompt = (
            "You maintain a small, permanent profile of the USER as a PERSON. It is read on every "
            "turn of every future conversation, so a wrong or trivial entry is expensive and a "
            "missing one costs nothing. Default to NOTHING.\n\n"
            "SAVE only a fact that passes ALL FIVE:\n"
            "1. It is about the person: who they are, their role, their tools and languages, how "
            "they want to be worked with, a constraint or standing rule they set.\n"
            "2. They stated or clearly demonstrated it about THEMSELVES. Never infer a trait from "
            "the fact that they asked about a topic once.\n"
            "3. It is still true in six months, whatever they happen to be working on then.\n"
            "4. It changes how an assistant should behave in an UNRELATED future conversation.\n"
            "5. It is not already obvious from whatever they are working on at the time.\n\n"
            "NEVER save: what they are building or its features; anything about the current task, "
            "bug, file, or request; a topic they asked about; anything the ASSISTANT said, did, or "
            "suggested; anything time-bound; secrets, keys, tokens, or passwords.\n\n"
            'GOOD: "Prefers answers with real measured numbers over estimates" - '
            '"Works solo and ships releases himself" - "Writes TypeScript and Python".\n'
            'BAD: "Works on an app with Slack OAuth and pinch-to-zoom" (that is the project, not '
            'the person) - "Interested in AI agents and LLM tooling" (that is just the topic they '
            'raised) - "Wants a weekly news digest" (that is a request they made).\n\n'
            "Write each fact self-contained, third person, under 200 characters.\n"
            f"Return at most {MAX_FACTS_PER_DISTILL} facts, one per line, no numbering, no quotes. "
            "Most conversations should yield none: if in any doubt, return the single word NOTHING."
        )
        # Show it what is already known. Without this the model re-derives facts it recorded weeks
        # ago, phrased differently every time, and the store's token-overlap guard cannot catch a
        # paraphrase: the four duplicate pairs found in a real memory scored 0.11 to 0.33 against a
        # 0.60 threshold. The generator is semantic, so the dedupe has to be too.
        known = "\n".join(f"- {f.text}" for f in store.list_facts())
        already = (
            "Facts already stored (do NOT repeat these, in any wording):\n" + known + "\n\n"
            "Return a fact ONLY if it is genuinely new, or is strictly more specific than one above "
            "(in which case return the sharper version and it will replace the old one).\n\n"
        ) if known else ""
        user_turn = already + "Conversation:\n<transcript>\n" + tail + "\n</transcript>\n\nExtract the facts."
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
