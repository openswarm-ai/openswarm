"""Onboarding payoff generation: a cheap, provider-agnostic LLM call that turns the user's persona
(+ name) into a personalized landing: one honest insight line, one high-value task an agent could
DO, and 4 concrete options. This replaces the hardcoded floor so the payoff is dynamic per user.

No data is read here (that's the separate profiling agent) so it works for everyone, instantly, on
the free-trial tier. Fail-open: any miss returns None and the frontend keeps its static fallback.
"""

import asyncio
import json
import logging
import re
from typing import List, Optional
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field
from typeguard import typechecked

from backend.apps.agents.core.aux_llm import aux_max_tokens_for
from backend.apps.agents.providers.registry import resolve_aux_model
from backend.apps.settings.credentials import get_anthropic_client_for_model
from backend.apps.settings.settings import load_settings

logger = logging.getLogger(__name__)

SUGGEST_TIMEOUT_S = 20.0
# aux_max_tokens_for is tuned for tiny labels (~100); this JSON (insight + task + 4 options) needs
# real room or it truncates mid-object and the parse fails. Floor at 900, keep the GPT-5 bump.
SUGGEST_MAX_TOKENS = 900

SYSTEM_PROMPT = (
    "You set up the first screen a brand-new OpenSwarm user sees. OpenSwarm is NOT a chatbot: its AI "
    "agents go and DO real work, browse the web live, build and run little tools, automate chores, "
    "watch things and ping you. Given who the user is, write their landing content.\n"
    "RULES: plain language a non-dev instantly gets; NEVER invent specific facts about them (no 'your "
    "launch next week' you cannot know, keep the insight general and true); everything is an ACTION an "
    "agent DOES (go, build, watch, chase, clean up, find), never 'ask me' or 'let's chat'; no bracketed "
    "placeholders like [framework]; never use em-dashes or en-dashes, use commas or periods.\n"
    "Return ONLY this JSON, nothing else:\n"
    '{"insight": "<ONE short warm sentence, max 12 words. Specific enough to feel like you get them '
    '(name their kind of work), but never invent exact facts you cannot know>", '
    '"task": "<the single most useful thing an agent could DO for them right now, a concrete instruction, '
    'something a chatbot cannot do>", '
    '"options": [{"label": "<3-6 word verb-first phrase>", "prompt": "<a clear runnable instruction>"}]}\n'
    "Give exactly 4 options."
)


class SuggestOption(BaseModel):
    model_config = ConfigDict(validate_assignment=True)
    label: str
    prompt: str


class PayoffSuggestion(BaseModel):
    model_config = ConfigDict(validate_assignment=True)
    insight: str
    task: str
    options: List[SuggestOption] = Field(default_factory=list)


@typechecked
def p_parse(text: str) -> Optional[PayoffSuggestion]:
    """Fence-strip + take the last balanced {...} + validate shape. Fail returns None."""
    if not text:
        return None
    cleaned = re.sub(r"```(?:json)?", "", text).strip()
    depth = 0
    start = end = -1
    for i in range(len(cleaned) - 1, -1, -1):
        c = cleaned[i]
        if c == "}":
            if depth == 0:
                end = i
            depth += 1
        elif c == "{":
            depth -= 1
            if depth == 0:
                start = i
                break
    if start < 0 or end < 0:
        return None
    try:
        raw = json.loads(cleaned[start : end + 1])
    except Exception:
        return None
    if not isinstance(raw, dict):
        return None
    insight, task, options_raw = raw.get("insight"), raw.get("task"), raw.get("options")
    if not isinstance(insight, str) or not isinstance(task, str) or not isinstance(options_raw, list):
        return None
    options: List[SuggestOption] = []
    for opt in options_raw:
        if isinstance(opt, dict) and isinstance(opt.get("label"), str) and isinstance(opt.get("prompt"), str):
            options.append(SuggestOption(label=opt["label"], prompt=opt["prompt"]))
    if not insight.strip() or not task.strip() or len(options) < 1:
        return None
    return PayoffSuggestion(insight=insight.strip(), task=task.strip(), options=options)


@typechecked
async def suggest_payoff(persona: str, name: str) -> Optional[PayoffSuggestion]:
    try:
        settings = load_settings()
        aux_model = (await resolve_aux_model(settings, preferred_tier="haiku"))[0]
        client = get_anthropic_client_for_model(settings, aux_model)
        user_turn = f"The user chose '{persona}' as where they want help first."
        if name.strip():
            user_turn += f" Their name is {name.strip()}."

        chunks: List[str] = []

        async def run() -> None:
            async with client.messages.stream(
                model=aux_model,
                max_tokens=max(SUGGEST_MAX_TOKENS, aux_max_tokens_for(aux_model)),
                system=SYSTEM_PROMPT,
                messages=[{"role": "user", "content": user_turn}],
                extra_headers={"X-Openswarm-Task-Id": uuid4().hex},
            ) as stream:
                async for text in stream.text_stream:
                    chunks.append(text)

        await asyncio.wait_for(run(), timeout=SUGGEST_TIMEOUT_S)
        return p_parse("".join(chunks))
    except Exception:
        logger.exception("onboarding-suggest: generation failed, falling back to floor")
        return None
