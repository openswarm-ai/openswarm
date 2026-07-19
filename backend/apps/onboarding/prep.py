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
    '{"greeting": string, "starters": [{"title": string, "prompt": string, "reason": string}], "app_title": string, "app_prompt": string, "app_reason": string, "research_title": string, "research_prompt": string, "research_reason": string, "automations": [{"title": string, "prompt": string, "cadence": "daily"|"weekday"|"weekly"}]}. '
    "First, silently infer a short, confident profile of this user: who they are and what they are working on. "
    "If usage_summary is present it is the STRONGEST signal (it is what they actually ask their AI about and facts "
    "their AI remembers about them); weight it above everything else, then signal_apps (the high-signal tools they "
    "have installed, like an IDE, a design app, or a DAW: these reveal their craft), then folders, plan tier, email "
    "domain. Tune every task and the personal app to that profile; do not output the profile. "
    "Exactly 4 starters. Each title is 2-5 words that PLAINLY say what the task does (like 'Sort my "
    "Downloads' or 'Compare headphones'), never clever, punny, or brand-style. Each prompt is a concrete, safe, immediately runnable task "
    "referencing the user's real folders, file counts, or picked apps when possible; never invent facts, never "
    "propose deleting anything without review. The FIRST starter must be an audit sized for parallel sub-work "
    "(inspect folders, cross-reference, produce one report); it may create ONE new report file but must never "
    "modify or delete existing files, because it may be run automatically on the user's behalf. Every starter "
    "must produce a tangible result the user can see (a sorted "
    "folder, a report, a working page); never propose setup, documentation of preferences, or planning-only tasks. "
    "Each starter's 'reason' is ONE short standalone clause (max 12 words, no leading 'because') naming the SPECIFIC "
    "real thing you observed (a folder, a file count, a picked app, a usage fact) that makes this task useful for THIS "
    "user; it must be grounded in the input facts, never invented, and read like a person pointing at what they saw. "
    "Design ONE personal app and make it the CENTERPIECE: an interactive single-page dashboard that mirrors THIS "
    "user's world, drawn from usage_summary and their files. It surfaces the real projects they are juggling, the "
    "threads or questions they keep returning to, and what they have been focused on lately, laid out as a clean "
    "visual dashboard they will want to keep open (cards, lists, a simple chart), seeded with their REAL specifics so "
    "it is unmistakably about them, not a generic template. app_title is 2-4 words that PLAINLY say what it is (like "
    "'Your Work Dashboard' or 'Project Hub'), never clever or punny; app_prompt starts with 'Build me' and names the "
    "actual sections to include using the user's real projects and topics; self-contained, no accounts or API keys. "
    "app_reason follows the same one-clause grounded-observation rule as a starter reason. "
    "Also pick the SINGLE topic this user most repeatedly asks their AI about (from usage_summary; if it is thin, use "
    "their strongest work signal from signal_apps or folders) and turn it into a live web-research task. research_title "
    "is 2-4 words plainly naming the topic (like 'App Store Fees' or 'Best Vector DBs'), never clever or punny. "
    "research_prompt is one instruction telling the agent to search the web RIGHT NOW and produce a tight, useful, "
    "current answer or comparison of THAT topic for this user (an actual answer, never a plan); it must demand "
    "THIS-YEAR information with publication dates on sources, so the answer cannot quietly be stale training data. "
    "research_reason follows the one-clause grounded-observation rule and names the specific recurring question you saw. "
    "Also propose 2-3 automations: recurring routines worth running on a schedule for THIS user, drawn from their "
    "profile and habits (for example a daily morning brief, a weekly folder cleanup, a weekday summary of their "
    "connected apps). Each automation title is 2-4 words that plainly name the routine (like 'Downloads Cleanup' or "
    "'Morning Brief'), cadence is exactly 'daily', 'weekday', or 'weekly'. The prompt is the COMPLETE instruction an "
    "agent executes alone on each scheduled run with NO human present: it must produce its result in one pass, never "
    "ask questions, never wait for input, and never set up schedules or reminders (the schedule already exists; "
    "writing 'remind me' or 'set up a log' is wrong, 'summarize X into a file' is right). "
    "Automations must be safe to run unattended (never delete without review). "
    "The greeting is one or two warm sentences: first say out loud, specifically and confidently, what this person is "
    "into or working on (grounded in usage_summary, signal_apps, and folders, for example 'Looks like you live in "
    "Xcode and ship iOS apps'), then name 2-3 concrete things you actually saw. Be specific, never generic, and never "
    "name boring system apps. Never use em-dashes or en-dashes anywhere. No markdown, no commentary, JSON only."
)


P_CURLY_QUOTES = {"“": '"', "”": '"', "‘": "'", "’": "'"}


@typechecked
def p_normalize_json_text(text: str) -> str:
    for bad, good in P_CURLY_QUOTES.items():
        text = text.replace(bad, good)
    return text


@typechecked
def p_strip_trailing_commas(s: str) -> str:
    return re.sub(r",(\s*[}\]])", r"\1", s)


@typechecked
def p_strip_dashes(s: str) -> str:
    """The house style bans em/en dashes and the model slips them into the greeting anyway, so
    guarantee it in code: turn a dash-clause into a comma-clause, then tidy any doubled punctuation."""
    s = s.replace(" — ", ", ").replace("—", ", ").replace(" – ", ", ").replace("–", ", ")
    s = re.sub(r"\s+([,.;:])", r"\1", s)
    s = re.sub(r",\s*,", ", ", s)
    s = re.sub(r"\s{2,}", " ", s)
    return s.strip()


@typechecked
def p_load_object(text: str) -> dict:
    """Best-effort load of the outermost JSON object: strict first, then a
    trailing-comma repair. Returns {} if neither parses (salvage handles the rest)."""
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if not match:
        return {}
    for candidate in (match.group(0), p_strip_trailing_commas(match.group(0))):
        try:
            parsed = json.loads(candidate)
            if isinstance(parsed, dict):
                return parsed
        except Exception:
            continue
    return {}


@typechecked
def p_salvage_flat_objects(text: str) -> List[dict]:
    """Pull every complete flat {..} object out of a truncated/malformed blob so a
    cut-off response still yields the starters it did finish (partial > generic)."""
    out: List[dict] = []
    for m in re.finditer(r"\{[^{}]*\}", text):
        try:
            obj = json.loads(p_strip_trailing_commas(m.group(0)))
        except Exception:
            continue
        if isinstance(obj, dict):
            out.append(obj)
    return out


@typechecked
def p_build_starters(rows: List[dict]) -> List[PersonalizedStarter]:
    return [
        PersonalizedStarter(title=p_strip_dashes(str(s.get("title", ""))), prompt=p_strip_dashes(str(s.get("prompt", ""))), reason=p_strip_dashes(str(s.get("reason", ""))))
        for s in rows
        if isinstance(s, dict) and str(s.get("title", "")).strip() and str(s.get("prompt", "")).strip() and "cadence" not in s
    ]


@typechecked
def p_extract_string_field(text: str, name: str) -> str:
    """Pull a top-level "name": "value" string straight out of the raw blob, for the fields that
    aren't objects (greeting, app_*) so they survive when the strict JSON load failed and we salvage."""
    m = re.search(rf'"{name}"\s*:\s*"((?:[^"\\]|\\.)*)"', text)
    return m.group(1).strip() if m else ""


@typechecked
def p_build_automations(rows: List[dict]) -> List[PersonalizedAutomation]:
    return [
        PersonalizedAutomation(
            title=p_strip_dashes(str(a.get("title", ""))),
            prompt=p_strip_dashes(str(a.get("prompt", ""))),
            cadence=(str(a.get("cadence", "weekly")).strip().lower() if str(a.get("cadence", "")).strip().lower() in VALID_CADENCE else "weekly"),
        )
        for a in rows
        if isinstance(a, dict) and str(a.get("title", "")).strip() and str(a.get("prompt", "")).strip()
    ]


@typechecked
def parse_prep(text: str) -> Optional[PrepResponse]:
    text = p_normalize_json_text(text)
    data = p_load_object(text)
    starters = p_build_starters(data.get("starters") if isinstance(data.get("starters"), list) else [])
    automations = p_build_automations(data.get("automations") if isinstance(data.get("automations"), list) else [])
    greeting = str(data.get("greeting", "")).strip()
    app_title = str(data.get("app_title", "")).strip()
    app_prompt = str(data.get("app_prompt", "")).strip()
    app_reason = str(data.get("app_reason", "")).strip()
    research_title = str(data.get("research_title", "")).strip()
    research_prompt = str(data.get("research_prompt", "")).strip()
    research_reason = str(data.get("research_reason", "")).strip()

    # Truncation / trailing comma / smart quotes broke the strict load: salvage the complete pieces
    # rather than throwing the whole personalized reveal away for one bad character.
    if not starters or not automations:
        objs = p_salvage_flat_objects(text)
        if not starters:
            starters = p_build_starters([o for o in objs if "cadence" not in o])
        if not automations:
            automations = p_build_automations([o for o in objs if "cadence" in o])
    # Top-level string fields don't live in the flat objects above, so recover them by name when the
    # strict load dropped them (a malformed response was still yielding starters but a blank app).
    if not greeting:
        greeting = p_extract_string_field(text, "greeting")
    if not app_title:
        app_title = p_extract_string_field(text, "app_title")
    if not app_prompt:
        app_prompt = p_extract_string_field(text, "app_prompt")
    if not app_reason:
        app_reason = p_extract_string_field(text, "app_reason")
    if not research_title:
        research_title = p_extract_string_field(text, "research_title")
    if not research_prompt:
        research_prompt = p_extract_string_field(text, "research_prompt")
    if not research_reason:
        research_reason = p_extract_string_field(text, "research_reason")

    if not starters:
        return None
    return PrepResponse(
        greeting=p_strip_dashes(greeting),
        starters=starters[:4],
        app_title=p_strip_dashes(app_title),
        app_prompt=p_strip_dashes(app_prompt),
        app_reason=p_strip_dashes(app_reason),
        research_title=p_strip_dashes(research_title),
        research_prompt=p_strip_dashes(research_prompt),
        research_reason=p_strip_dashes(research_reason),
        automations=automations[:3],
    )


@typechecked
def p_scan_grounded_fallback(request: PrepRequest) -> PrepResponse:
    """When the aux call can't be made (a sole gemini/codex lane returns empty on 0.3.60, provider
    down, no anthropic-reachable model), still ground the reveal in the REAL scan via a template so a
    cross-provider user gets their-Mac-specific starters, not generic stubs. No LLM, so it never fails."""
    scan = request.scan
    if scan is None:
        return PrepResponse(greeting="", starters=list(FALLBACK_STARTERS))
    downloads = next((f for f in scan.folders if f.name == "Downloads" and f.entry_count > 0), None)
    apps = scan.signal_apps[:3]
    bits: List[str] = []
    if downloads:
        bits.append(f"{downloads.entry_count} files in Downloads")
    if apps:
        bits.append(", ".join(apps))
    greeting = f"I took a look around your Mac: {'; '.join(bits)}. Here is where I would start." if bits else ""
    starters: List[PersonalizedStarter] = []
    if downloads:
        starters.append(PersonalizedStarter(
            title="Audit Downloads",
            prompt=f"Scan my Downloads folder ({downloads.entry_count} files) and produce one report grouping files by type with cleanup suggestions. Do not move or delete anything; write only the report.",
            reason=f"Downloads has {downloads.entry_count} files worth sorting.",
        ))
    for s in FALLBACK_STARTERS:
        if len(starters) >= 4:
            break
        if all(s.title != existing.title for existing in starters):
            starters.append(s)
    # Ground the research card on their top tool so the "looked into this" card still appears cross-provider.
    research_title = ""
    research_prompt = ""
    research_reason = ""
    if apps:
        research_title = f"{apps[0]} Tips"
        research_prompt = f"Search the web right now for the most useful current tips, shortcuts, and workflows for {apps[0]}, and give me a tight summary with sources."
        research_reason = f"You have {apps[0]} installed and use it a lot."
    return PrepResponse(
        greeting=greeting,
        starters=starters[:4],
        research_title=research_title,
        research_prompt=research_prompt,
        research_reason=research_reason,
    )


@typechecked
async def build_prep(settings: AppSettings, request: PrepRequest) -> PrepResponse:
    from datetime import date

    facts = request.model_dump()
    # The aux otherwise assumes its training-cutoff year and writes stale ranges like "2024-2025"
    # into research prompts; telling it today's date keeps "current" meaning current.
    facts["today"] = date.today().isoformat()
    try:
        from backend.apps.agents.providers.registry import resolve_aux_model
        from backend.apps.settings.credentials import get_anthropic_client_for_model

        aux_model, _ = await resolve_aux_model(settings, preferred_tier="haiku")
        client = get_anthropic_client_for_model(settings, aux_model)
        resp = await client.messages.create(
            model=aux_model,
            # The full shape (greeting + 4 starters w/ prompts + app + 3 automations) runs ~1.5-2K
            # tokens for a rich user; 1100 truncated the JSON mid-object so parse silently fell back.
            max_tokens=aux_max_tokens_for(aux_model, base=2200),
            system=P_SYSTEM,
            messages=[{"role": "user", "content": json.dumps(facts)}],
            # Bound the wait: the SDK default is ~10min, so a wedged router/provider would hang the
            # auto-launch (which awaits this) instead of degrading to the static starters.
            timeout=45.0,
        )
        parsed = parse_prep(safe_resp_text(resp))
        if parsed is not None:
            return parsed
    except Exception:
        pass
    # Aux unusable (empty gemini/codex response on 0.3.60, provider down, no anthropic lane): still
    # ground the reveal in the real scan rather than shipping generic stubs.
    return p_scan_grounded_fallback(request)
