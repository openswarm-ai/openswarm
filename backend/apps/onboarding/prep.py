"""Turn the local scan + app picks into a personalized greeting and starters.

One cheap aux call on whatever lane the user just connected; every failure path
returns the static fallback so the reveal can never be an error card.
"""

import json
import re
from typing import List, Optional

from typeguard import typechecked

from backend.apps.agents.core.aux_llm import aux_max_tokens_for, safe_resp_text
from backend.apps.onboarding.models import PrepRequest, PrepResponse
from backend.apps.settings.models import AppSettings, PersonalizedStarter

FALLBACK_STARTERS: List[PersonalizedStarter] = [
    PersonalizedStarter(title="Clean up Downloads", prompt="Sort my Downloads folder into tidy subfolders. Show me the plan before moving anything."),
    PersonalizedStarter(title="Research something", prompt="Research the best noise-cancelling headphones under $300 and give me a comparison table."),
    PersonalizedStarter(title="Build a tiny app", prompt="Build me a simple habit tracker app I can use right now."),
    PersonalizedStarter(title="Plan a trip", prompt="Plan a 3-day weekend trip itinerary and turn it into a printable page."),
]

P_SYSTEM = (
    "You write first-run starter tasks for OpenSwarm, a desktop AI agent platform that can "
    "organize local files, browse the web in a real browser, build small apps, and run agents in parallel. "
    "Given facts about the user's machine and the apps they picked, respond with STRICT JSON only: "
    '{"greeting": string, "starters": [{"title": string, "prompt": string}]}. '
    "Exactly 4 starters. Each title is 2-5 words. Each prompt is a concrete, safe, immediately runnable task "
    "referencing the user's real folders, file counts, or picked apps when possible; never invent facts, never "
    "propose deleting anything without review. The greeting is one warm sentence that names 2-3 specific things "
    "found on the machine. No markdown, no commentary, JSON only."
)


@typechecked
def parse_prep(text: str) -> Optional[PrepResponse]:
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if not match:
        return None
    try:
        data = json.loads(match.group(0))
        starters = [
            PersonalizedStarter(title=str(s.get("title", "")).strip(), prompt=str(s.get("prompt", "")).strip())
            for s in data.get("starters", [])
            if isinstance(s, dict) and str(s.get("title", "")).strip() and str(s.get("prompt", "")).strip()
        ]
        if not starters:
            return None
        return PrepResponse(greeting=str(data.get("greeting", "")).strip(), starters=starters[:4])
    except Exception:
        return None


@typechecked
async def build_prep(settings: AppSettings, request: PrepRequest) -> PrepResponse:
    facts = request.model_dump()
    try:
        from backend.apps.agents.providers.registry import resolve_aux_model
        from backend.apps.settings.credentials import get_anthropic_client_for_model

        aux_model, _ = await resolve_aux_model(settings, preferred_tier="haiku")
        client = get_anthropic_client_for_model(settings, aux_model)
        resp = await client.messages.create(
            model=aux_model,
            max_tokens=aux_max_tokens_for(aux_model, base=700),
            system=P_SYSTEM,
            messages=[{"role": "user", "content": json.dumps(facts)}],
        )
        parsed = parse_prep(safe_resp_text(resp))
        if parsed is not None:
            return parsed
    except Exception:
        pass
    return PrepResponse(greeting="", starters=list(FALLBACK_STARTERS))
