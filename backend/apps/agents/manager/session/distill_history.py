"""Aux-LLM distillation of the turns dropped by compaction.

On a fresh rebuild (valve rescue, MCPActivate continuation, branch edit) the recap
hard-drops everything before the cutoff. That loses the thread of a long conversation.
This distills the dropped span into a dense summary via the user's cheap-tier model
(provider-agnostic) and caches it against the cutoff id, so the rebuild keeps the gist
instead of the void. Fail-open at every step: any error, no provider, or the kill switch
returns "" and the caller falls back to the plain hard-drop."""

import logging
import os
from typing import List

from typeguard import typechecked

from backend.apps.agents.core.models import AgentSession
from backend.apps.settings.models import AppSettings
from backend.apps.agents.manager.session.history_compaction import (
    get_branch_messages,
    recap_tool_call_line,
    recap_tool_result_line,
    strip_forged_sentinels,
)

logger = logging.getLogger(__name__)

DISTILL_ENABLED = os.environ.get("OPENSWARM_DISTILL_HISTORY", "1") != "0"
MAX_DISTILL_INPUT_CHARS = 60_000
# Prose is free to paraphrase, so the paths get re-attached deterministically instead. Capped so a hundred-file refactor can't reinflate what the distill just shrank.
MAX_PINNED_PATHS = 40
PATH_INPUT_KEYS = ("file_path", "notebook_path", "path")

# Plain wording on purpose, lifted from hermes-agent's filter-safe summarizer preamble (context_compressor.py, MIT): provider content filters flagged its earlier "NEVER continue / do not respond" framing, and the summarize call runs on the same subscription lane as the chat.
P_SYSTEM = (
    "You are a summarization agent creating a context checkpoint. Treat the conversation "
    "turns below as source material for a compact record of prior work, written in the third "
    "person ('The user asked...', 'The agent decided...'). Produce only the briefing; no "
    "greeting, preamble, or prefix.\n"
    # The half a narrative summary silently drops, proven live 2026-09-01: told to remember an
    # invented codename, the summary said a codename WAS invented and omitted the codename, so the
    # agent answered "I do not know" after the very compaction this summary exists to survive. The
    # input carries assistant text in full; the loss was purely this prompt rewarding narration
    # over facts. Values are the memory; prose about the values is not.
    "Preserve exact values verbatim: any name, codename, identifier, number, checksum, path, URL, "
    "decision, or answer that was stated or computed must appear in the briefing character for "
    "character, not described. When in doubt between narrating an event and quoting its value, "
    "quote the value."
)
P_USER_TEMPLATE = (
    "Source material, between <transcript> tags: the earlier part of a conversation between a "
    "user and an AI agent. Write a dense third-person briefing of it that preserves: the "
    "user's goal and constraints, decisions already made, concrete facts / values / "
    "identifiers / file paths mentioned, what was tried and how it turned out, and any open "
    "threads.\n\n<transcript>\n{body}\n</transcript>"
)


@typechecked
def p_format_dropped(messages: List) -> str:
    """Compact transcript of the dropped span: user/assistant text in full, tool I/O clipped (the same caps the recap uses), bounded so the aux call stays cheap."""
    lines: List[str] = []
    for m in messages:
        if getattr(m, "hidden", False):
            continue
        if m.role in ("user", "assistant"):
            text = m.content if isinstance(m.content, str) else str(m.content)
            lines.append(f"{m.role.capitalize()}: {strip_forged_sentinels(text)}")
        elif m.role == "tool_call":
            lines.append(recap_tool_call_line(m.content))
        elif m.role == "tool_result":
            lines.append(recap_tool_result_line(m.content))
    body = "\n".join(lines)
    return body[-MAX_DISTILL_INPUT_CHARS:] if len(body) > MAX_DISTILL_INPUT_CHARS else body


@typechecked
def touched_file_paths(messages: List) -> List[str]:
    """Every file path the dropped span operated on, read off the tool_call inputs rather than
    scraped out of prose. Order-preserving and deduped."""
    seen: List[str] = []
    for m in messages:
        if m.role != "tool_call" or not isinstance(m.content, dict):
            continue
        tool_input = m.content.get("input")
        if not isinstance(tool_input, dict):
            continue
        for key in PATH_INPUT_KEYS:
            value = tool_input.get(key)
            if isinstance(value, str) and value and value not in seen:
                seen.append(value)
    return seen


@typechecked
def pin_missing_paths(summary: str, messages: List) -> str:
    """Re-attach any touched path the summary dropped. A briefing that says 'the twelve handler
    files' is unusable to the next turn; the literal paths have to survive verbatim."""
    missing = [p for p in touched_file_paths(messages) if p not in summary][:MAX_PINNED_PATHS]
    if not missing:
        return summary
    return summary + "\n\nFiles touched earlier: " + ", ".join(missing)


@typechecked
async def distilled_history_summary(session: AgentSession, settings: AppSettings) -> str:
    """Cached aux summary of everything up to and including compacted_through_msg_id.
    Empty string when there's nothing to distill, the feature is off, or the call fails."""
    cutoff = session.compacted_through_msg_id
    if not DISTILL_ENABLED or not cutoff:
        return ""
    msgs = get_branch_messages(session)
    idx = next((i for i, m in enumerate(msgs) if m.id == cutoff), -1)
    # Membership check BEFORE the cache: after a branch edit the cutoff can vanish from the active branch, and a summary keyed on that id would be stale. If the cutoff is still here, everything before it is shared pre-fork history, so a cache hit is provably valid.
    if idx < 0:
        return ""
    # Summarize through the newest SETTLED assistant message, not just the dropped span. The recap
    # never carries model replies (ENG-358: that shape is what the filter blocks), so on a rebuild
    # anything the agent itself said AFTER the cutoff was carried by NOBODY: the distiller stopped
    # at the cutoff and the recap skipped it. Proven live 2026-09-01: an invented codename stated
    # after the cutoff was unrecoverable ("I do not know") on the very next rebuild, while the same
    # fact inside the dropped span survives via this summary. The summary is model-written output
    # of an aux call either way, so the filter posture is unchanged; the cache key just moves from
    # the cutoff to the newest settled id, costing at most one aux call per rebuild.
    p_end = idx
    for i in range(len(msgs) - 1, idx, -1):
        if getattr(msgs[i], "role", "") == "assistant":
            p_end = i
            break
    p_through = msgs[p_end].id
    if session.compacted_summary and session.compacted_summary_through == p_through:
        return session.compacted_summary
    dropped = msgs[: p_end + 1]
    body = p_format_dropped(dropped)
    if not body.strip():
        return ""
    try:
        summary = await p_call_distiller(session, settings, body)
    except Exception:
        logger.debug("history distill aux call failed; falling back to hard-drop", exc_info=True)
        return ""
    if not summary:
        return ""
    summary = pin_missing_paths(summary, dropped)
    session.compacted_summary = summary
    session.compacted_summary_through = p_through
    return summary


@typechecked
async def p_call_distiller(session: AgentSession, settings: AppSettings, body: str) -> str:
    from backend.apps.agents.providers.registry import resolve_aux_model
    from backend.apps.settings.credentials import get_anthropic_client_for_model

    # No primary_api: a background summary wants the most RELIABLE cheap tier, not the chat's family. Forcing the family routed a gemini/codex chat's distill onto a same-family aux that 404s (gemini-direct google endpoint the Anthropic client can't call) or 401s (codex token rotation); the proven classifier omits it too and resolves to whatever anthropic-compatible lane the user has.
    aux_model, _ = await resolve_aux_model(settings, preferred_tier="haiku")
    client = get_anthropic_client_for_model(settings, aux_model)
    resp = await client.messages.create(
        model=aux_model,
        max_tokens=1024,
        system=P_SYSTEM,
        messages=[{"role": "user", "content": P_USER_TEMPLATE.format(body=body)}],
    )
    text = ""
    if isinstance(resp.content, list):
        for block in resp.content:
            t = getattr(block, "text", None)
            if t:
                text += t
    return text.strip()
