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
from backend.apps.settings.models import AppSettings, PersonalizedAutomation, PersonalizedStarter

VALID_CADENCE = {"daily", "weekday", "weekly"}

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
    '{"greeting": string, "starters": [{"title": string, "prompt": string, "reason": string}], "app_title": string, "app_prompt": string, "app_reason": string, "automations": [{"title": string, "prompt": string, "cadence": "daily"|"weekday"|"weekly"}]}. '
    "First, silently infer a short, confident profile of this user: who they are and what they are working on. "
    "If usage_summary is present it is the STRONGEST signal (it is what they actually ask their AI about and facts "
    "their AI remembers about them); weight it above everything else, then signal_apps (the high-signal tools they "
    "have installed, like an IDE, a design app, or a DAW: these reveal their craft), then folders, plan tier, email "
    "domain. Tune every task and the personal app to that profile; do not output the profile. "
    "Exactly 4 starters. Each title is 2-5 words. Each prompt is a concrete, safe, immediately runnable task "
    "referencing the user's real folders, file counts, or picked apps when possible; never invent facts, never "
    "propose deleting anything without review. The FIRST starter must be an audit sized for parallel sub-work "
    "(inspect folders, cross-reference, produce one report); it may create ONE new report file but must never "
    "modify or delete existing files, because it may be run automatically on the user's behalf. Every starter "
    "must produce a tangible result the user can see (a sorted "
    "folder, a report, a working page); never propose setup, documentation of preferences, or planning-only tasks. "
    "Each starter's 'reason' is ONE short standalone clause (max 12 words, no leading 'because') naming the SPECIFIC "
    "real thing you observed (a folder, a file count, a picked app, a usage fact) that makes this task useful for THIS "
    "user; it must be grounded in the input facts, never invented, and read like a person pointing at what they saw. "
    "Also design ONE small personal app for this user: app_title is 2-4 words, app_prompt starts with 'Build me' and "
    "describes a small, immediately useful single-page app tailored to the profile (their files, habits, or picked "
    "apps), self-contained with no accounts or API keys. app_reason follows the same one-clause grounded-observation "
    "rule as a starter reason. "
    "Also propose 2-3 automations: recurring routines worth running on a schedule for THIS user, drawn from their "
    "profile and habits (for example a daily morning brief, a weekly folder cleanup, a weekday summary of their "
    "connected apps). Each automation title is 2-4 words, prompt is one runnable instruction, cadence is exactly "
    "'daily', 'weekday', or 'weekly'. Automations must be safe to run unattended (never delete without review). "
    "The greeting is one or two warm sentences: first say out loud, specifically and confidently, what this person is "
    "into or working on (grounded in usage_summary, signal_apps, and folders, for example 'Looks like you live in "
    "Xcode and ship iOS apps'), then name 2-3 concrete things you actually saw. Be specific, never generic, and never "
    "name boring system apps. Never use em-dashes or en-dashes anywhere. No markdown, no commentary, JSON only."
)


@typechecked
def parse_prep(text: str) -> Optional[PrepResponse]:
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if not match:
        return None
    try:
        data = json.loads(match.group(0))
        starters = [
            PersonalizedStarter(title=str(s.get("title", "")).strip(), prompt=str(s.get("prompt", "")).strip(), reason=str(s.get("reason", "")).strip())
            for s in data.get("starters", [])
            if isinstance(s, dict) and str(s.get("title", "")).strip() and str(s.get("prompt", "")).strip()
        ]
        if not starters:
            return None
        automations = [
            PersonalizedAutomation(
                title=str(a.get("title", "")).strip(),
                prompt=str(a.get("prompt", "")).strip(),
                cadence=(str(a.get("cadence", "weekly")).strip().lower() if str(a.get("cadence", "")).strip().lower() in VALID_CADENCE else "weekly"),
            )
            for a in data.get("automations", [])
            if isinstance(a, dict) and str(a.get("title", "")).strip() and str(a.get("prompt", "")).strip()
        ]
        return PrepResponse(
            greeting=str(data.get("greeting", "")).strip(),
            starters=starters[:4],
            app_title=str(data.get("app_title", "")).strip(),
            app_prompt=str(data.get("app_prompt", "")).strip(),
            app_reason=str(data.get("app_reason", "")).strip(),
            automations=automations[:3],
        )
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
            max_tokens=aux_max_tokens_for(aux_model, base=1100),
            system=P_SYSTEM,
            messages=[{"role": "user", "content": json.dumps(facts)}],
        )
        parsed = parse_prep(safe_resp_text(resp))
        if parsed is not None:
            return parsed
    except Exception:
        pass
    return PrepResponse(greeting="", starters=list(FALLBACK_STARTERS))
