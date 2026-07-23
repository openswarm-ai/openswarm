"""Turn the local scan + app picks into a personalized greeting and starters.

One cheap aux call on whatever lane the user just connected; every failure path
returns the static fallback so the reveal can never be an error card.
"""

import json
import re
from typing import List, Optional

from typeguard import typechecked

from backend.apps.agents.core.aux_llm import aux_max_tokens_for, safe_resp_text
from backend.apps.onboarding.models import PrepRequest, PrepResponse, ScanResult
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
    '{"headline": string, "greeting": string, "starters": [{"title": string, "prompt": string, "reason": string}], "app_title": string, "app_prompt": string, "app_reason": string, "research_title": string, "research_prompt": string, "research_reason": string, "browser_title": string, "browser_prompt": string, "browser_reason": string, "automations": [{"title": string, "prompt": string, "cadence": "daily"|"weekday"|"weekly"}]}. '
    "First, silently infer a short, confident profile of this user: who they are and what they are working on. "
    "If usage_summary is present it is the STRONGEST signal (a distilled profile of who this person is and what "
    "they actually work on, read from their real AI conversations); weight it above everything else. Do NOT let a "
    "single installed app override it: signal_apps (an IDE, a design app, a DAW) is only a WEAK hint about their "
    "craft (having Xcode installed does not make someone an iOS developer), used only to color what the profile "
    "already says, then folders, plan tier, email domain. Tune every task and the personal app to that profile; "
    "do not output the profile. "
    "THE BAR every single item must clear: it is either (a) SPECIFICALLY useful to THIS person's real work in a way "
    "they could not quickly get elsewhere (it uses their ACTUAL files, projects, or data to produce a real finished "
    "thing worth keeping), OR (b) a genuine 'oh, it can do THAT?' that makes them see a hundred uses (a surprising "
    "capability shown on their real stuff). A generic chore FAILS the bar and must be replaced: a file-cleanup report, "
    "a folder audit, a read-only summary or mirror dashboard of their data, a research overview they could google, an "
    "empty log file, or any 'set up / organize / plan' task is BANNED. "
    "SPAN THE WHOLE PERSON. First, silently list this person's DISTINCT life threads from the profile (for example: "
    "their main work or product, their sport or fitness, their food or local life, their tech or tooling curiosity, "
    "their games or hobbies, a recurring practical need). Then assign the four starters to FOUR DIFFERENT threads, "
    "one each. HARD RULE: treat EVERYTHING about their company, product, startup, pitch, competitive landscape, "
    "positioning, pricing, fundraising, growth, or the thing they are building as ONE single 'work' bucket. EXACTLY "
    "ONE of the four starters may come from that work bucket, no more, count them before you answer. The other THREE "
    "must each come from a clearly DIFFERENT NON-work thread you actually see in the profile (their sport or fitness, "
    "their food or local life, their games or hobbies, a personal curiosity or practical need). Anything work-adjacent, "
    "even a browser tool 'for the product' or research 'for the pitch', is WORK and does NOT count as a non-work "
    "thread. Before you finalize, verify that THREE of the four starters have nothing to do with their work; if they "
    "do, replace them. The app and the research should also lean to NON-work threads, not pile onto the work one. The "
    "ONLY exception: if the profile genuinely shows they talk about almost nothing but that one thing, follow the real "
    "data instead of forcing variety. Every item still clears the bar on its own. "
    "Exactly 4 starters. Each title is 2-5 words that PLAINLY say what the task does (like 'Frame my screenshots' or "
    "'Compare headphones'), never clever, punny, or brand-style. Each prompt is a concrete, safe, immediately runnable "
    "task referencing the user's real folders, files, or picked apps; never invent facts. The FIRST starter is the one "
    "that RUNS automatically, so it must be safe unattended AND clear the bar: a real, specific DELIVERABLE built from "
    "the user's ACTUAL files that they'd want and could not quickly make themselves (a designer with many screenshots: "
    "a browsable gallery page of their app screenshots; someone with many notebooks or PDFs of one kind: an indexed, "
    "searchable library page of them). It READS their real files and writes ONE new artifact (a page or a file); it "
    "must NEVER modify or delete an existing file. It must NOT be a cleanup report, a folder audit, or a 'plan'. Every "
    "starter must produce a tangible result the user can see and want; never propose setup, documentation of "
    "preferences, or planning-only tasks. "
    "Each starter's 'reason' is ONE short standalone clause (max 12 words, no leading 'because') naming the SPECIFIC "
    "real thing you observed (a folder, a file count, a picked app, a usage fact) that makes this task useful for THIS "
    "user; it must be grounded in the input facts, never invented, and read like a person pointing at what they saw. "
    "Design ONE small but genuinely useful WORKING TOOL for this person's craft and make it the CENTERPIECE, this is "
    "the 'oh, it can build me THAT?' moment. It must DO something: take their input and produce useful output, or "
    "automate a fiddly micro-task they repeat in their ACTUAL work (inferred from usage_summary + signal_apps). It is "
    "a real interactive tool they would reopen and USE, NOT a read-only dashboard, NOT a mirror of their data, NOT a "
    "summary, NOT a feed. Examples of the SHAPE only (never copy, always tailor to THEM, and never "
    "default to an iOS, app, or coding tool just because it is a familiar example): for a writer, a tool that "
    "rewrites a pasted paragraph across tones; for a data person, a tool that pastes a CSV and instantly charts it; "
    "for a musician, a tool that transposes a chord progression; for a language learner, a drill built from words "
    "they paste. Match the shape to THIS person's actual craft from the profile. app_title 2-4 words that plainly name what it DOES "
    "(like 'Icon Previewer' or 'Screenshot Framer'), never punny. app_prompt starts with 'Build me' and specifies the "
    "tool's INPUT, what it PRODUCES, and the interaction; fully client-side and self-contained. It MUST run "
    "on the user's input with DETERMINISTIC logic only (math, parsing, formatting, layout, charts, filtering, "
    "transforms). It must NEVER call an AI model, an LLM, a chat completion, or any network/remote API, those "
    "only work inside a published app and will fail in the reveal with 'make sure you're on a published app'. "
    "If the idea would need AI generation to work, pick a DIFFERENT tool that doesn't (no accounts, no API keys, "
    "no backend, no fetch, everything computed in the browser). app_reason follows the same one-clause grounded-"
    "observation rule as a starter reason and says why THIS tool fits their real work. "
    "Also pick the SINGLE topic this user most repeatedly asks their AI about (from usage_summary; if it is thin, use "
    "their strongest work signal from signal_apps or folders) and turn it into a live web-research task. research_title "
    "is 2-4 words plainly naming the topic (like 'App Store Fees' or 'Best Vector DBs'), never clever or punny. "
    "research_prompt is one instruction telling the agent to search the web RIGHT NOW and produce a tight, useful, "
    "current answer or comparison of THAT topic for this user (an actual answer, never a plan); it must demand "
    "THIS-YEAR information with publication dates on sources, so the answer cannot quietly be stale training data. "
    "research_reason follows the one-clause grounded-observation rule and names the specific recurring question you saw. "
    "Also design ONE browser task that shows the agent DRIVING a real website live (so the user watches it control a "
    "browser, not just fetch text). browser_title is 2-4 words plainly naming it (like 'Nearby Michelin' or 'Jump "
    "Threads'). browser_prompt tells the agent to OPEN a specific real, PUBLIC website by name and do a genuinely "
    "MULTI-STEP task there: navigate, search, click through, read across a few pages, compare, then report what it "
    "found. It must be safe read-only browsing on public pages only, NEVER log in, buy, post, submit, or act on the "
    "user's behalf. Pick a topic from a DIFFERENT thread than the app and the research, ideally a fun or personal "
    "interest (food, sport, travel, a hobby), not their work. browser_reason follows the one-clause grounded rule. "
    "THE FOUR THINGS THAT ACTUALLY RUN are the app, the research, the browser task, and the first automation. This "
    "rule OVERRIDES every 'pick their craft / their top topic' hint above: assign each of these four to a DIFFERENT "
    "thread of this person's life, and AT MOST ONE of the four may touch their work/company/product/pitch/competitors, "
    "count them before you answer. FIXED ASSIGNMENT: the APP must be built for a NON-work thread (a hobby, sport, "
    "food, or personal need), it is a delightful surprise precisely because it is NOT about their job (a jump-log "
    "tool, a restaurant picker, a practice-drill tool, never a pitch/competitor/metrics dashboard). The BROWSER task "
    "must also take a clearly personal or fun NON-work thread. Only the RESEARCH may be about their work, and only if "
    "that is genuinely their burning question; if you use work for the research, then the first automation must be "
    "NON-work too, so no more than ONE of the four is ever about work. Make all four GENUINELY MULTI-STEP (several "
    "real actions, never a one-liner). "
    "Also propose 1-2 automations: recurring routines that genuinely help THIS user and clear the bar (NEVER a folder "
    "cleanup, NEVER an empty log, NEVER 'keep a dashboard updated'). A good one delivers something the user actually "
    "wants on a cadence, e.g. a daily digest of what is new in their SPECIFIC niche (named from usage_summary and "
    "signal_apps) written to a dated file they will read, or a weekly pull of new items relevant to a project they are "
    "shipping. Each automation title is 2-4 words that plainly name it (like 'iOS Design Digest'), cadence is exactly "
    "'daily', 'weekday', or 'weekly'. The prompt is the COMPLETE instruction an agent executes alone on each scheduled "
    "run with NO human present: produce its result in one pass, never ask questions, never wait for input, never set up "
    "schedules or reminders (the schedule already exists), and write the result to a concrete file (like "
    "Documents/<name>_<date>.md). 'Search X and write the result to Y' is right; 'remind me' or 'set up a log' is wrong. "
    "Safe to run unattended (never delete without review). "
    "The HEADLINE is the single most important line: a punchy, specific, SCANNABLE identity hook of AT MOST 10 "
    "words that this person reads in one second and thinks 'yes, that's me'. Name their actual work and their one "
    "defining trait, no filler, no full sentence, no period. It is read at a glance in big type, so it must NOT be "
    "a paragraph. Example shapes only (never copy, tailor to THEM): 'OpenSwarm founder who measures everything, "
    "vertical jump to agent latency' or 'Ships iOS apps, obsessed with the last 5% of polish'. Sharp, not wordy. "
    "The greeting is one or two warm, punchy sentences that make this person feel INSTANTLY understood, the "
    "'wait, it actually gets me' hook. Lead with the single most specific true thing about them from the profile "
    "(their actual project BY NAME, their real craft, the obsession they keep returning to), then add ONE more "
    "concrete detail that proves you get them. Ground it in the profile above all; nod to a folder or tool only if "
    "it sharpens the picture, never lead with a generic installed app, and never name boring system apps. It should "
    "read like a sharp friend who knows exactly what you're about, not a system reciting what it scanned. Do not be "
    "creepy: name their work and interests, not private personal numbers. Never use em-dashes or en-dashes anywhere. "
    "No markdown, no commentary, JSON only."
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
    headline = str(data.get("headline", "")).strip()
    greeting = str(data.get("greeting", "")).strip()
    app_title = str(data.get("app_title", "")).strip()
    app_prompt = str(data.get("app_prompt", "")).strip()
    app_reason = str(data.get("app_reason", "")).strip()
    research_title = str(data.get("research_title", "")).strip()
    research_prompt = str(data.get("research_prompt", "")).strip()
    research_reason = str(data.get("research_reason", "")).strip()
    browser_title = str(data.get("browser_title", "")).strip()
    browser_prompt = str(data.get("browser_prompt", "")).strip()
    browser_reason = str(data.get("browser_reason", "")).strip()

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
    if not headline:
        headline = p_extract_string_field(text, "headline")
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
    if not browser_title:
        browser_title = p_extract_string_field(text, "browser_title")
    if not browser_prompt:
        browser_prompt = p_extract_string_field(text, "browser_prompt")
    if not browser_reason:
        browser_reason = p_extract_string_field(text, "browser_reason")

    if not starters:
        return None
    return PrepResponse(
        headline=p_strip_dashes(headline),
        greeting=p_strip_dashes(greeting),
        starters=starters[:4],
        app_title=p_strip_dashes(app_title),
        app_prompt=p_strip_dashes(app_prompt),
        app_reason=p_strip_dashes(app_reason),
        research_title=p_strip_dashes(research_title),
        research_prompt=p_strip_dashes(research_prompt),
        research_reason=p_strip_dashes(research_reason),
        browser_title=p_strip_dashes(browser_title),
        browser_prompt=p_strip_dashes(browser_prompt),
        browser_reason=p_strip_dashes(browser_reason),
        automations=automations[:3],
    )


@typechecked
def p_scan_grounded_starters(scan: ScanResult) -> List[PersonalizedStarter]:
    """Build starters from the REAL scan (no LLM): each references something concrete on this machine, a
    screenshot pile, a content-heavy folder, the app they lean on, their code projects. Every one produces
    a keepable artifact and never modifies an existing file, so even the no-LLM path is genuinely tailored."""
    out: List[PersonalizedStarter] = []
    apps = scan.signal_apps[:3]
    # Screenshots -> a browsable gallery page (real deliverable from their real files).
    shots = next((f for f in scan.folders if f.screenshot_count > 2), None)
    if shots:
        out.append(PersonalizedStarter(
            title="Frame my screenshots",
            prompt=f"Find the screenshot images in my {shots.name} folder and build one browsable gallery web page showing them as a neat scrollable grid. Write only the new page; never move or delete the originals.",
            reason=f"{shots.screenshot_count} screenshots sitting in {shots.name}.",
        ))
    # A content-heavy folder -> a searchable index page of what's in it.
    docs = next((f for f in scan.folders if f.name in ("Documents", "Downloads", "Desktop") and f.entry_count > 5 and f.top_extensions), None)
    if docs:
        ext = docs.top_extensions[0].lstrip(".") or "file"
        out.append(PersonalizedStarter(
            title=f"Index my {ext} files",
            prompt=f"Look through my {docs.name} folder and build one searchable index page listing my {ext} files with their names and dates so I can find things fast. Write only the new page; do not move or delete anything.",
            reason=f"{docs.entry_count} files in {docs.name}, lots of .{ext}.",
        ))
    # Top signal app -> live web research for current tips (a real answer, not a plan).
    if apps:
        out.append(PersonalizedStarter(
            title=f"{apps[0]} tips",
            prompt=f"Search the web right now for the most useful current tips, shortcuts, and workflows for {apps[0]}, and give me a tight summary with dated sources.",
            reason=f"You lean on {apps[0]} a lot.",
        ))
    # Code projects -> a plain-English recap of where each stands.
    if scan.git_repo_count > 0:
        out.append(PersonalizedStarter(
            title="Recap my projects",
            prompt="Look at the code projects on my computer, read each one's README and recent activity, and write me one short page summarizing what each project is and where it stands. Write only the summary; change nothing.",
            reason=f"{scan.git_repo_count} code projects on your machine.",
        ))
    return out


@typechecked
def p_scan_grounded_fallback(request: PrepRequest) -> PrepResponse:
    """When the aux call can't be made (a sole gemini/codex lane returns empty on 0.3.60, provider
    down, no anthropic-reachable model), still ground the reveal in the REAL scan via a template so a
    cross-provider user gets their-Mac-specific starters, not generic stubs. No LLM, so it never fails."""
    scan = request.scan
    if scan is None:
        return PrepResponse(greeting="", starters=list(FALLBACK_STARTERS))
    apps = scan.signal_apps[:3]
    starters = p_scan_grounded_starters(scan)
    # Backfill from the generic list ONLY to reach four, and only when the machine was too sparse to
    # ground three real ones. On a normal Mac all four come from the scan, so 3-of-4 stays tailored.
    for s in FALLBACK_STARTERS:
        if len(starters) >= 4:
            break
        if all(s.title != existing.title for existing in starters):
            starters.append(s)
    downloads = next((f for f in scan.folders if f.name == "Downloads" and f.entry_count > 0), None)
    bits: List[str] = []
    if downloads:
        bits.append(f"{downloads.entry_count} files in Downloads")
    if apps:
        bits.append(", ".join(apps))
    greeting = f"I took a look around your Mac: {'; '.join(bits)}. Here is where I would start." if bits else ""
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


# The clustering pass: one cheap read that turns the raw chat dump into a tight character read, so the
# reveal reasons over "who is this person" instead of skimming fragments and latching onto a stray word.
P_PROFILE_SYSTEM = (
    "You are reading a person's OWN recent AI chat conversations (their messages and the AI's replies, "
    "most recent first). Write a SHORT, confident, specific profile of who this person actually is and "
    "what they genuinely work on and care about, grounded ONLY in what you see. 3 to 5 sentences, plain "
    "prose, no lists, no hedging, no preamble, no 'based on'. Name concrete specifics: the projects they "
    "are building, the tools and languages they use, the topics they return to again and again, their "
    "interests and side-obsessions, how they think. Separate a real recurring throughline from a one-off "
    "tangent, weight what they keep coming back to. If one thing is clearly their main focus right now, "
    "say so plainly; if their attention is split across a few real threads, name them. Never invent "
    "anything not present. No markdown. Never use em-dashes or en-dashes."
)

# Below this the usage text is just titles/memories (thin); above it there is real conversation content
# worth a distill pass. Keep the distill input bounded so the cheap call stays a couple cents.
P_PROFILE_DISTILL_THRESHOLD = 1500
P_PROFILE_INPUT_CAP = 140000


@typechecked
async def p_distill_profile(settings: AppSettings, usage_text: str) -> str:
    """One cheap aux call: raw chat content -> a tight 'who is this person' profile. "" on any failure,
    so build_prep just falls back to feeding the raw usage text (today's behavior)."""
    try:
        from backend.apps.agents.providers.registry import resolve_aux_model
        from backend.apps.settings.credentials import get_anthropic_client_for_model

        aux_model, _ = await resolve_aux_model(settings, preferred_tier="haiku")
        client = get_anthropic_client_for_model(settings, aux_model)
        resp = await client.messages.create(
            model=aux_model,
            max_tokens=aux_max_tokens_for(aux_model, base=600),
            system=P_PROFILE_SYSTEM,
            messages=[{"role": "user", "content": usage_text[:P_PROFILE_INPUT_CAP]}],
            timeout=45.0,
        )
        return p_strip_dashes(safe_resp_text(resp).strip())
    except Exception:
        return ""


@typechecked
async def build_prep(settings: AppSettings, request: PrepRequest) -> PrepResponse:
    from datetime import date

    facts = request.model_dump()
    # The aux otherwise assumes its training-cutoff year and writes stale ranges like "2024-2025"
    # into research prompts; telling it today's date keeps "current" meaning current.
    facts["today"] = date.today().isoformat()
    # If the usage text carries real conversation content, distill it to a tight profile FIRST so the
    # reveal call reasons over who this person is, not raw logs (and stays in budget). Fail-open: a blank
    # profile just leaves the raw text in place, which is today's behavior.
    usage = str(facts.get("usage_summary", ""))
    if len(usage) > P_PROFILE_DISTILL_THRESHOLD:
        profile = await p_distill_profile(settings, usage)
        if profile:
            facts["usage_summary"] = profile
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
