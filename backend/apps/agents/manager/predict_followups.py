"""Aux-LLM follow-up prediction for ONE chat: guess the user's next message in THIS conversation,
in their exact voice, from the conversation itself. Sibling of predict_prompts.py (which predicts
across chats from topic history); this one only ever reads the given session. Provider-agnostic
cheap tier; fail-open to [] so the chat renders nothing instead of an error."""

import logging
from typing import List

from typeguard import typechecked

from backend.apps.agents.core.aux_llm import aux_max_tokens_for
from backend.apps.agents.core.models import AgentSession
from backend.apps.agents.manager.predict_prompts import parse_suggestion_lines
from backend.apps.agents.manager.session.history_compaction import get_branch_messages

logger = logging.getLogger(__name__)

MAX_FOLLOWUPS = 3
# No suggestions until the conversation has a real shape: below two full exchanges any guess is
# generic filler, and the empty-chat starters already cover turn zero.
MIN_EXCHANGES = 2
# Enough tail to know where the conversation is, small enough to stay a sub-cent aux call.
P_TAIL_MESSAGES = 12
P_PER_MESSAGE_CAP = 700
# The model's own words go in gisted and unlabelled. This tail is sent to an aux model on the
# user's own lane (a Claude subscription for most people), and up to 12 turns of verbatim
# `User:/Assistant:` was the exact shape ENG-358 removed from the recap, spent here on suggestion
# chips. Whether the filter keys on it is unknown; the trade is not, so it costs a gist (ENG-396).
MODEL_TEXT_CAP = 200


@typechecked
def followups_eligible(session: AgentSession) -> bool:
    """True once this branch holds >= MIN_EXCHANGES completed user->assistant exchanges."""
    msgs = get_branch_messages(session)
    users = sum(1 for m in msgs if m.role == "user" and not getattr(m, "hidden", False))
    assistants = sum(1 for m in msgs if m.role == "assistant")
    return min(users, assistants) >= MIN_EXCHANGES


def conversation_tail(session: AgentSession) -> str:
    lines: List[str] = []
    for m in get_branch_messages(session)[-P_TAIL_MESSAGES:]:
        if getattr(m, "hidden", False) or m.role not in ("user", "assistant"):
            continue
        text = m.content if isinstance(m.content, str) else str(m.content)
        if m.role == "user":
            # The user's own words are not model output; they are what we are predicting from.
            lines.append(f"They asked: {text[:P_PER_MESSAGE_CAP]}"
                         + ("..." if len(text) > P_PER_MESSAGE_CAP else ""))
        else:
            gist = text[:MODEL_TEXT_CAP] + ("..." if len(text) > MODEL_TEXT_CAP else "")
            lines.append(f"They were answered, in gist: {gist}")
    return "\n".join(lines)


@typechecked
async def predict_followups(session: AgentSession, count: int = MAX_FOLLOWUPS) -> List[str]:
    """Up to `count` plausible next messages for THIS chat, in the user's voice. [] on any miss."""
    try:
        if not followups_eligible(session):
            return []
        from backend.apps.settings.credentials import get_anthropic_client_for_model
        from backend.apps.agents.providers.registry import resolve_aux_model
        from backend.apps.settings.settings import load_settings

        global_settings = load_settings()
        tail = conversation_tail(session)
        if not tail:
            return []
        aux_model = (await resolve_aux_model(global_settings, preferred_tier="haiku"))[0]
        client = get_anthropic_client_for_model(global_settings, aux_model)

        system_prompt = (
            "You predict the next message a user might send in an ONGOING conversation with their "
            "AI agent. You never answer or explain; you only produce plausible follow-ups the USER "
            "would type next in THIS conversation.\n\n"
            "Mimic the user's exact writing style from their messages in the transcript: their "
            "casing, punctuation, brevity, slang. If they write lowercase two-word asks, so do you.\n\n"
            f"Return exactly {count} follow-ups, one per line, no numbering, no quotes, no preamble. "
            "Each under ~80 characters, each a DIFFERENT direction (dig deeper, next step, adjacent "
            "ask), each specific to this conversation's actual content, never generic."
        )
        user_turn = (
            "Conversation so far:\n<transcript>\n" + tail + "\n</transcript>\n\n"
            f"Predict {count} messages this user might send next."
        )

        chunks: List[str] = []
        async with client.messages.stream(
            model=aux_model,
            max_tokens=aux_max_tokens_for(aux_model, base=200),
            system=system_prompt,
            messages=[{"role": "user", "content": user_turn}],
        ) as stream:
            async for text in stream.text_stream:
                chunks.append(text)
        return parse_suggestion_lines("".join(chunks), count)
    except Exception as e:
        logger.info(f"[predict-followups] fail-open ([]): {e}")
        return []
