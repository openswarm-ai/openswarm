"""Pre-flight MCP suggestion classifier.

Runs before a new agent launches. Given the user's initial prompt, decides:
  1. Is this prompt vague or information-gathering (is_vague) — used to
     conditionally inject the discovery scaffolding into the system prompt.
  2. Does it suggest a not-yet-connected MCP that would dramatically
     improve the outcome — surfaced to the user as a one-click
     "Connect X" modal before the agent runs.

Only the curated shortlist of MCPs we ship and have vetted is considered.
The full community MCP registry is NOT mined for suggestions — flaky/
unvetted entries would make the "magic" moment feel broken.

Provider-agnostic: calls whatever cheap-tier aux model the user has wired
via `resolve_aux_model` (Haiku / GPT-5.4-mini / Gemini-2.5-flash / etc.).
If no provider is connected, fails open (no suggestions, no scaffolding).
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from typing import Any

from backend.apps.agents.providers.registry import resolve_aux_model
from backend.apps.settings.credentials import get_anthropic_client_for_model
from backend.apps.settings.settings import load_settings
from backend.apps.tools_lib.tools_lib import _load_all as load_all_tools

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Tool-agnostic discovery scaffolding — appended to the agent's system prompt
# only when preflight flags the prompt as vague/information-gathering.
# ---------------------------------------------------------------------------
DISCOVERY_SCAFFOLDING = (
    "# Discovery before action\n"
    "When a request is vague or could be grounded in user context, do not "
    "guess generic defaults. First silently enumerate what would change the "
    "output — voice, tone, audience, prior context, recent precedent, facts "
    "that only live in the user's data. Then look at your available tools and "
    "pick the ones that could answer those unknowns. Read a few examples "
    "(usually 3–10 is enough), summarize what you found into a few bullets, "
    "then act confidently.\n\n"
    "Tool-selection hierarchy for information gathering:\n"
    "  1. Direct local access (filesystem reads, code search, shell) — "
    "cheapest and fastest.\n"
    "  2. Connected services / MCP tools — for user data that lives in a "
    "linked account (email, calendar, notes, tickets, etc.).\n"
    "  3. Web search / fetch — for public information that isn't in your "
    "training cutoff.\n"
    "  4. Browser automation — only when a real interactive session or "
    "login is required.\n"
    "  5. Sub-agents — only for parallelizable subtasks or to isolate heavy "
    "context. Not for serial steps.\n\n"
    "Asking the user is a fallback, not a first move. Never fabricate. If "
    "no tool can ground a critical unknown, ask one concise question."
)


# ---------------------------------------------------------------------------
# Curated MCP shortlist. These `id` values MUST match the exact `name` field
# on ToolDefinition entries that OpenSwarm ships as defaults (see
# `backend/data/tools/*.json` — one file per tool, `name` is the canonical
# key used everywhere else in the app). Mismatches would cause the
# enabled/disabled filter to no-op and the frontend modal to render nothing.
#
# Keep in sync with the Custom Action Sets list in Settings → Tools.
# ---------------------------------------------------------------------------
CuratedEntry = dict[str, Any]

CURATED_SHORTLIST: list[CuratedEntry] = [
    {
        "id": "Google Workspace",
        "title": "Google Workspace",
        "description": "Gmail, Calendar, Drive, Docs, Sheets, Slides — for reading/sending email, checking the user's schedule, and pulling context from their documents.",
    },
    {
        "id": "Microsoft 365",
        "title": "Microsoft 365",
        "description": "Outlook email, Calendar, OneDrive, Teams, Excel, OneNote — Microsoft-stack equivalent of Google Workspace.",
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
        "description": "CRM contacts, deals, companies, tickets — when the user's task involves their customer relationships.",
    },
    {
        "id": "Airtable",
        "title": "Airtable",
        "description": "Read and write records, manage bases, tables, and fields in the user's Airtable.",
    },
    {
        "id": "Reddit",
        "title": "Reddit",
        "description": "Browse subreddits, search posts, analyze users — when the task involves public Reddit content.",
    },
    {
        "id": "YouTube",
        "title": "YouTube",
        "description": "Video transcripts, details, comments, channel stats, search — when the task involves YouTube content.",
    },
]


# ---------------------------------------------------------------------------
# Local skip filter — short-circuits the LLM call for obviously-local prompts
# where no MCP could add value. Saves ~200ms + ~$0.0001 per launch.
# ---------------------------------------------------------------------------
_PATH_LIKE = re.compile(r"^[./~]|/[\w\-]+/|\.[a-zA-Z]{1,5}\b")
_SHELL_PREFIX = re.compile(r"^\s*[\$!/]")


def _is_obviously_local(prompt: str) -> bool:
    """Heuristic: does this prompt obviously not need any MCP?

    Returns True for:
      - very short prompts (< 8 chars, likely greetings or acknowledgments)
      - shell-command-ish prompts ("! ls", "$ git status", "/clear")
      - prompts that are essentially a single file path reference
    On True we skip preflight entirely; the agent launches with no
    scaffolding and no suggestion modal.
    """
    s = prompt.strip()
    if len(s) < 8:
        return True
    if _SHELL_PREFIX.match(s):
        return True
    # Single-token path-ish prompt (e.g. "./src/foo.ts")
    if " " not in s and _PATH_LIKE.search(s):
        return True
    return False


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

async def run_preflight(prompt: str, timeout_s: float = 2.0) -> dict:
    """Classify the user's prompt and return suggestions + vagueness flag.

    Always returns a dict of shape:
        {"is_vague": bool, "suggestions": [Suggestion, ...]}

    Never raises: any failure (no provider, aux model timeout, bad JSON)
    fails open — returns is_vague=False and empty suggestions.
    """
    default: dict[str, Any] = {"is_vague": False, "suggestions": []}

    if not prompt or not prompt.strip():
        return default

    if _is_obviously_local(prompt):
        return default

    try:
        settings = load_settings()
        available = _build_available_shortlist(settings)
        if not available:
            # Everything in the shortlist is either enabled, dismissed, or
            # out-of-scope for this user. We still run the classifier (for
            # is_vague) but with an empty candidate list — the model will
            # only fill in is_vague and return no suggestions.
            pass

        result = await asyncio.wait_for(
            _call_classifier(settings, prompt, available),
            timeout=timeout_s,
        )
        # Re-validate suggestion ids against the curated shortlist so a
        # hallucinated id can't reach the frontend.
        valid_ids = {e["id"] for e in CURATED_SHORTLIST}
        result["suggestions"] = [
            _decorate(s, available) for s in result.get("suggestions", [])
            if isinstance(s, dict) and s.get("id") in valid_ids
        ]
        # Drop anything that ended up with no matching available entry
        # (e.g. already enabled by the user between preflight and now).
        result["suggestions"] = [s for s in result["suggestions"] if s is not None]
        result["is_vague"] = bool(result.get("is_vague"))
        # Suppress suggestions on concrete prompts. False-positives here
        # are worse than missed positives — interrupting a user who typed
        # "refactor foo.ts" to ask about GitHub MCP would feel broken.
        # Vague/info-gathering prompts are where suggestions help; concrete
        # tasks should just launch.
        if not result["is_vague"]:
            result["suggestions"] = []
        return result
    except asyncio.TimeoutError:
        logger.info("preflight: classifier timed out, failing open")
        return default
    except Exception as e:
        logger.info(f"preflight: classifier failed ({type(e).__name__}: {e}); failing open")
        return default


def _build_available_shortlist(settings) -> list[CuratedEntry]:
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


def _decorate(llm_suggestion: dict, available: list[CuratedEntry]) -> dict | None:
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


async def _call_classifier(settings, prompt: str, available: list[CuratedEntry]) -> dict:
    """One aux-model call, returns validated JSON {is_vague, suggestions}."""
    aux_model, _base = await resolve_aux_model(settings, preferred_tier="haiku")
    client = get_anthropic_client_for_model(settings, aux_model)

    catalog_lines = "\n".join(
        f"- id: {e['id']} | {e['title']} — {e['description']}"
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
    )

    # Extract text content. Handle both string and content-block shapes.
    text = ""
    if isinstance(resp.content, list):
        for block in resp.content:
            t = getattr(block, "text", None)
            if t:
                text += t
    else:
        text = str(resp.content)

    text = text.strip()
    # Strip any accidental code fences
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```\s*$", "", text)

    data = json.loads(text)
    if not isinstance(data, dict):
        raise ValueError("classifier did not return an object")
    if not isinstance(data.get("suggestions", []), list):
        data["suggestions"] = []
    return data
