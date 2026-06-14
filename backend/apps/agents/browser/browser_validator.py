"""
Last-resort adjudication for a stuck browser sub-agent.

Deterministic stagnation detection (browser_loop) handles the common cases for
free. When it's exhausted (a run of actions with no progress despite escalating
nudges), we make ONE cheap aux-tier LLM call to suggest a concrete next step.
It is rare by construction, so the cost stays near zero. The model + client are
resolved provider-agnostically by the caller (cheap tier of whatever provider
the user has connected), so nothing here hardcodes Anthropic/Haiku.
"""

import logging

logger = logging.getLogger(__name__)

P_ADJUDICATION_PROMPT = (
    "A browser automation agent is stuck: its recent actions produced no "
    "progress on the page.\n\n"
    "GOAL: {goal}\n\n"
    "RECENT ACTIONS (most recent last):\n{recent}\n\n"
    "CURRENT PAGE (truncated):\n{page}\n\n"
    "In 2 to 3 sentences, give the single most promising concrete next step. "
    "Prefer, in order: a different element or selector, a keyboard shortcut "
    "(Tab then Enter), scrolling to reveal a hidden control, or calling "
    "RequestHumanIntervention if this is a login / captcha / 2FA wall. Be "
    "specific and brief; do not restate the goal."
)


def p_extract_text(response) -> str:
    """Pull the text out of an Anthropic-style response object."""
    parts = []
    for block in getattr(response, "content", None) or []:
        if getattr(block, "type", None) == "text" and getattr(block, "text", ""):
            parts.append(block.text.strip())
    return " ".join(p for p in parts if p).strip()


async def adjudicate_stuck(
    client, model: str, goal: str, recent_actions: str, page_text: str,
) -> str:
    """One cheap aux call returning concrete guidance, or "" on any failure."""
    prompt = P_ADJUDICATION_PROMPT.format(
        goal=(goal or "(unknown)")[:400],
        recent=(recent_actions or "(none)")[:1200],
        page=(page_text or "(empty)")[:1500],
    )
    try:
        response = await client.messages.create(
            model=model,
            max_tokens=300,
            messages=[{"role": "user", "content": prompt}],
        )
    except Exception as e:
        logger.warning(f"[browser-validator] adjudication call failed: {e}")
        return ""
    return p_extract_text(response)
