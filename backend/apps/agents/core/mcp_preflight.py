"""Pre-flight classifier; decides is_vague (scaffolding inject) + suggests an MCP to connect. Fails open."""

from __future__ import annotations

import asyncio
import json
import logging
import re
from typing import Any

from backend.apps.agents.providers.registry import resolve_aux_model
from backend.apps.settings.credentials import get_anthropic_client_for_model
from backend.apps.settings.settings import load_settings
from backend.apps.tools_lib.tools_lib import load_all_tools as load_all_tools
from backend.apps.tools_lib.mcp_config import sanitize_server_name

logger = logging.getLogger(__name__)


# Curated shortlist; `id` MUST match ToolDefinition.name exactly or the enabled/dismissed filter no-ops and the modal renders nothing.
CuratedEntry = dict[str, Any]

CURATED_SHORTLIST: list[CuratedEntry] = [
    {
        "id": "Google Workspace",
        "title": "Google Workspace",
        "description": "Gmail, Calendar, Drive, Docs, Sheets, Slides; for reading/sending email, checking the user's schedule, and pulling context from their documents.",
    },
    {
        "id": "Microsoft 365",
        "title": "Microsoft 365",
        "description": "Outlook email, Calendar, OneDrive, Teams, Excel, OneNote; Microsoft-stack equivalent of Google Workspace.",
    },
    {
        "id": "Slack",
        "title": "Slack",
        "description": "Search channels and DMs, read history, send messages in the user's Slack workspace.",
    },
    {
        "id": "Discord",
        "title": "Discord",
        "description": "Read messages, send messages, manage channels, interact with Discord servers via the OpenSwarm bot.",
    },
    {
        "id": "Notion",
        "title": "Notion",
        "description": "Search and update the user's Notion pages, databases, and wikis.",
    },
    {
        "id": "HubSpot",
        "title": "HubSpot",
        "description": "CRM contacts, deals, companies, tickets; when the user's task involves their customer relationships.",
    },
    {
        "id": "Airtable",
        "title": "Airtable",
        "description": "Read and write records, manage bases, tables, and fields in the user's Airtable.",
    },
    {
        "id": "GitHub",
        "title": "GitHub",
        "description": "Repos, issues, pull requests, Actions, code search, gists; when the task involves the user's GitHub.",
    },
    {
        "id": "Reddit",
        "title": "Reddit",
        "description": "Browse, search, post, comment, vote, save, subscribe, and DM on Reddit from the user's own logged-in session; for reading or acting on Reddit.",
    },
    {
        "id": "X",
        "title": "X (Twitter)",
        "description": "Read the timeline, search, post/reply/quote, like, retweet, bookmark, follow, and DM on X (Twitter) from the user's own logged-in session; for reading or acting on X.",
    },
    {
        "id": "TikTok",
        "title": "TikTok",
        "description": "Browse the feed, search, read videos/comments, like, comment, follow, and favorite on TikTok from the user's own logged-in session; for reading or acting on TikTok.",
    },
    {
        "id": "YouTube",
        "title": "YouTube",
        "description": "Video transcripts, details, comments, channel stats, search; when the task involves YouTube content.",
    },
]


# Short-circuit for obviously-local prompts where no MCP helps. Saves ~200ms + ~$0.0001 per launch.
P_PATH_LIKE = re.compile(r"^[./~]|/[\w\-]+/|\.[a-zA-Z]{1,5}\b")
P_SHELL_PREFIX = re.compile(r"^\s*[\$!/]")


def p_is_obviously_local(prompt: str) -> bool:
    """True for prompts that obviously can't benefit from MCP (very short, shell-ish, single path)."""
    s = prompt.strip()
    if len(s) < 8:
        return True
    if P_SHELL_PREFIX.match(s):
        return True
    if " " not in s and P_PATH_LIKE.search(s):
        return True
    return False


async def run_preflight(prompt: str, timeout_s: float = 8.0, task_id: str | None = None, require_vague: bool = True) -> dict:
    """Classify the prompt and return {is_vague, suggestions}; never raises. require_vague=False
    keeps suggestions even on a concrete prompt: used when the agent already proved it needs an
    integration (it called MCPSearch), so the "don't interrupt concrete tasks" guard no longer applies."""
    default: dict[str, Any] = {"is_vague": False, "suggestions": []}

    if not prompt or not prompt.strip():
        return default

    if p_is_obviously_local(prompt):
        return default

    try:
        settings = load_settings()
        available = p_build_available_shortlist(settings)

        result = await asyncio.wait_for(
            p_call_classifier(settings, prompt, available, task_id),
            timeout=timeout_s,
        )
        # Re-validate ids against the curated shortlist so hallucinations can't reach the frontend.
        valid_ids = {e["id"] for e in CURATED_SHORTLIST}
        result["suggestions"] = [
            p_decorate(s, available) for s in result.get("suggestions", [])
            if isinstance(s, dict) and s.get("id") in valid_ids
        ]
        result["suggestions"] = [s for s in result["suggestions"] if s is not None]
        result["is_vague"] = bool(result.get("is_vague"))
        # Suppress on concrete prompts; false-positives feel broken (interrupting "refactor foo.ts" to suggest GitHub MCP).
        if require_vague and not result["is_vague"]:
            result["suggestions"] = []
        return result
    except asyncio.TimeoutError:
        logger.info("preflight: classifier timed out, failing open")
        return default
    except Exception as e:
        logger.info(f"preflight: classifier failed ({type(e).__name__}: {e}); failing open")
        return default


def p_build_available_shortlist(settings) -> list[CuratedEntry]:
    """Curated entries that are NOT currently enabled and NOT dismissed."""
    try:
        enabled_names = {t.name for t in load_all_tools() if getattr(t, "enabled", False)}
    except Exception:
        enabled_names = set()

    dismissed = set((getattr(settings, "dismissed_mcp_suggestions", {}) or {}).keys())

    return [
        entry for entry in CURATED_SHORTLIST
        if entry["id"] not in enabled_names and entry["id"] not in dismissed
    ]


def offer_for_gated_server(server_name: str, settings) -> CuratedEntry | None:
    """Mid-run a running agent may reach for a vetted MCP it isn't granted; this maps that
    server to a one-click connect offer to SHOW the user. Suggest-only by construction: it
    returns data to display, never an action that grants access, so it cannot widen the MCP
    surface (activation stays behind MCPActivate + the dispatch gate). Returns None unless the
    server is vetted AND inactive AND not dismissed, reusing the same filter as the preflight."""
    if not server_name or not isinstance(server_name, str):
        return None
    # The hot-path hands us a sanitized slug ("google-workspace"); curated ids are display names ("Google Workspace"). Match on the slug of both sides so neither form is a load-bearing string.
    slug = sanitize_server_name(server_name)
    entry = next(
        (e for e in p_build_available_shortlist(settings) if sanitize_server_name(e["id"]) == slug),
        None,
    )
    if entry is None:
        return None
    return {"id": entry["id"], "title": entry["title"], "description": entry["description"], "reason": ""}


def p_decorate(llm_suggestion: dict, available: list[CuratedEntry]) -> dict | None:
    """Expand an LLM-returned {id, reason} into the full frontend shape."""
    entry = next((e for e in available if e["id"] == llm_suggestion["id"]), None)
    if entry is None:
        return None
    return {
        "id": entry["id"],
        "title": entry["title"],
        "description": entry["description"],
        "reason": (llm_suggestion.get("reason") or "").strip()[:200],
    }


async def p_call_classifier(settings, prompt: str, available: list[CuratedEntry], task_id: str | None = None) -> dict:
    """One aux-model call, returns validated JSON {is_vague, suggestions}."""
    aux_model, p_base = await resolve_aux_model(settings, preferred_tier="haiku")
    client = get_anthropic_client_for_model(settings, aux_model)

    catalog_lines = "\n".join(
        f"- id: {e['id']} | {e['title']}; {e['description']}"
        for e in available
    ) or "- (no candidate services available for this user)"

    system = (
        "You classify a single user request to help a downstream agent. "
        "Output MUST be strict JSON matching this schema:\n"
        "  {\"is_vague\": boolean, \"suggestions\": [{\"id\": string, \"reason\": string}]}\n\n"
        "Field definitions:\n"
        "- is_vague: true if the request is underspecified or would benefit "
        "from grounding in the user's data before answering (e.g. \"write me "
        "an email\", \"summarize my meeting\", \"what's on my schedule\"). "
        "false for concrete self-contained tasks (\"fix this bug\", \"refactor "
        "foo.ts\", \"what's 2+2\", \"list files in ./src\").\n"
        "- suggestions: up to 2 CANDIDATE SERVICE ids (from the catalog "
        "below) whose connection would dramatically improve the outcome. "
        "Only include a service if the request clearly implies it. If no "
        "service clearly fits, return an empty array. Never invent ids.\n"
        "  Google Workspace and Microsoft 365 overlap (email, calendar, "
        "docs/drive). When the request implies one of these capabilities but "
        "does NOT name the provider (e.g. \"email\" without saying Gmail/"
        "Outlook or Google/Microsoft), suggest BOTH so the user picks. If the "
        "provider is named or implied, suggest only that one.\n"
        "- reason: one short sentence (<20 words) explaining WHY this "
        "service fits this request.\n\n"
        "Return ONLY the JSON. No prose, no markdown fences, no explanation."
    )
    user_turn = (
        "Candidate services (may be empty):\n"
        f"{catalog_lines}\n\n"
        "User request:\n"
        f"<request>\n{prompt}\n</request>"
    )

    resp = await client.messages.create(
        model=aux_model,
        max_tokens=300,
        system=system,
        messages=[{"role": "user", "content": user_turn}],
        # Rides on its query's free-trial run instead of opening its own; ignored off the free lane.
        extra_headers={"X-Openswarm-Task-Id": task_id} if task_id else {},
    )

    text = ""
    if isinstance(resp.content, list):
        for block in resp.content:
            t = getattr(block, "text", None)
            if t:
                text += t
    else:
        text = str(resp.content)

    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```\s*$", "", text)

    data = json.loads(text)
    if not isinstance(data, dict):
        raise ValueError("classifier did not return an object")
    if not isinstance(data.get("suggestions", []), list):
        data["suggestions"] = []
    return data
