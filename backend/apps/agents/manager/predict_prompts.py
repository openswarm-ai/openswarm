"""Aux-LLM prompt prediction: guess a few prompts the user might type next, in their own voice,
from what they've already worked on (recent chat topics + onboarding starters). Provider-agnostic
(cheap tier of whichever provider is connected); fail-open to [] so the composer just falls back to
its static placeholder when there is no signal, no provider, or the call errors."""

import logging
import re
from typing import List

from typeguard import typechecked

from backend.apps.agents.core.aux_llm import aux_max_tokens_for
from backend.apps.agents.manager.session.session_store import load_all_session_data
from backend.apps.settings.settings import load_settings

logger = logging.getLogger(__name__)

MAX_TOPICS = 24
MAX_SUGGESTIONS = 5
# Don't predict someone's next prompt until we ACTUALLY know their patterns. Below this many real
# past chats, any guess is just noise (onboarding starters alone are what they browsed at setup, not
# a read on what they want now), so we stay silent and let the neutral placeholder stand.
MIN_REAL_TOPICS = 4
# Names the aux title-gen hands out for empty/greeting chats; they carry no topic signal.
P_SKIP_NAMES = {"untitled", "new chat", "greeting", "chat", ""}


def p_recent_topics(limit: int = MAX_TOPICS) -> List[str]:
    """Recent chat topic titles (the aux-distilled 2-4 word names), newest first, deduped."""
    data = load_all_session_data()
    data.sort(
        key=lambda pair: pair[1].get("closed_at") or pair[1].get("created_at") or "",
        reverse=True,
    )
    topics: List[str] = []
    seen = set()
    for _sid, d in data:
        name = (d.get("name") or "").strip()
        low = name.lower()
        if low in P_SKIP_NAMES or low in seen:
            continue
        seen.add(low)
        topics.append(name)
        if len(topics) >= limit:
            break
    return topics


def p_parse_lines(raw: str, count: int) -> List[str]:
    """One suggestion per line; strip bullets/numbering/quotes, drop empties, cap at count."""
    out: List[str] = []
    for line in raw.splitlines():
        s = line.strip()
        s = re.sub(r"^\s*(?:[-*•]|\d+[.)])\s*", "", s).strip()
        s = s.strip('"“”‘’')
        if s and len(s) <= 140:
            out.append(s)
        if len(out) >= count:
            break
    return out


@typechecked
async def predict_prompts(count: int = MAX_SUGGESTIONS) -> List[str]:
    """Predict up to `count` short prompts the user might type next, in their style. [] on any miss."""
    try:
        from backend.apps.settings.credentials import get_anthropic_client_for_model
        from backend.apps.agents.providers.registry import resolve_aux_model

        global_settings = load_settings()
        topics = p_recent_topics()
        starters = [
            (s.prompt or "").strip()
            for s in (global_settings.personalized_starters or [])
            if getattr(s, "prompt", None)
        ]
        # Only predict once there's a real track record. Onboarding starters can enrich a prediction
        # but never trigger one on their own: a brand-new user hasn't shown us what they want yet.
        if len(topics) < MIN_REAL_TOPICS:
            return []

        aux_model = (await resolve_aux_model(global_settings, preferred_tier="haiku"))[0]
        client = get_anthropic_client_for_model(global_settings, aux_model)

        name = (global_settings.user_name or "").strip()
        signal_lines: List[str] = []
        if topics:
            signal_lines.append("Recent things they worked on: " + "; ".join(topics))
        if starters:
            signal_lines.append("Tasks they were interested in: " + "; ".join(starters[:6]))
        signal = "\n".join(signal_lines)

        system_prompt = (
            "You predict what a user is likely to type next into their AI agent platform, based on "
            "what they already work on. You NEVER answer or explain; you only produce plausible next "
            "prompts in the USER'S voice (imperative, first person, the way someone types to their "
            "own assistant), matching their topics and phrasing.\n\n"
            f"Return exactly {count} short prompts, one per line, no numbering, no quotes, no preamble. "
            "Each is a single line under ~90 characters, concrete and immediately actionable. Vary "
            "them across the topics; do not repeat a task they clearly just finished verbatim."
        )
        user_turn = (
            (f"The user's name is {name}.\n" if name else "")
            + "Here is what this user works on:\n<signal>\n"
            + signal
            + f"\n</signal>\n\nPredict {count} prompts they might type next."
        )

        chunks: List[str] = []
        async with client.messages.stream(
            model=aux_model,
            max_tokens=aux_max_tokens_for(aux_model, base=300),
            system=system_prompt,
            messages=[{"role": "user", "content": user_turn}],
        ) as stream:
            async for text in stream.text_stream:
                chunks.append(text)
        return p_parse_lines("".join(chunks), count)
    except Exception as e:
        logger.info(f"[predict-prompts] fail-open ([]): {e}")
        return []
