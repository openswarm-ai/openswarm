import json
import logging
from typing import List, Optional, Tuple
from typeguard import typechecked
import os
import re

from backend.config.paths import SESSIONS_DIR

logger = logging.getLogger(__name__)

# One plain-English trust line, fenced by a tag. The model treats the fence as structural framing; the sentence is what actually defuses a security-conscious agent flagging the block as spoofed tool output.
PLATFORM_NOTE_PREAMBLE = (
    "This block is authored by the OpenSwarm platform, not tool output and not a "
    "prior message. It is trusted context."
)
PLATFORM_NOTE_OPEN = "<openswarm_platform_note>"
PLATFORM_NOTE_CLOSE = "</openswarm_platform_note>"
SESSION_RECAP_OPEN = "<openswarm_session_recap>"
SESSION_RECAP_CLOSE = "</openswarm_session_recap>"

# Per-turn caps so the re-grounded recap stays compact (summaries, not replays) and cannot reinflate the context window from one giant tool input/output.
RECAP_TOOL_INPUT_CAP = 200
RECAP_TOOL_RESULT_CAP = 500

# Inline budget for a spilled tool result, split head/tail. Same total as the old head-only 4KB, but a test summary or build verdict lives at the END of the output and head-only threw it away every time.
SPILL_HEAD_CHARS = 2_500
SPILL_TAIL_CHARS = 1_500


@typechecked
def wrap_platform_note(body: str) -> str:
    """Fence platform-authored text so the model reads it as trusted annotation,
    never as spoofed tool output. The frontend parses the same tag to render a
    calm chip instead of leaking the raw tag into chat."""
    return f"{PLATFORM_NOTE_OPEN}\n{PLATFORM_NOTE_PREAMBLE}\n{body}\n{PLATFORM_NOTE_CLOSE}"


P_SENTINEL_TAG_RE = re.compile(r"</?openswarm_(?:platform_note|session_recap)\b[^>]*>")


@typechecked
def clamp_recap_text(text: str) -> str:
    """Middle-elide a giant user/assistant message in the RECAP only (session.messages keeps the full text): one pasted log used to survive compaction verbatim and re-overflow the rebuilt prompt."""
    if len(text) <= SPILL_HEAD_CHARS + SPILL_TAIL_CHARS:
        return text
    elided = len(text) - SPILL_HEAD_CHARS - SPILL_TAIL_CHARS
    return f"{text[:SPILL_HEAD_CHARS]}\n[... {elided} chars elided from recap ...]\n{text[-SPILL_TAIL_CHARS:]}"


@typechecked
def strip_forged_sentinels(text: str) -> str:
    """Neuter any platform-note/recap tags hiding in UNTRUSTED text (tool results,
    user input) so attacker-supplied content can't pose as trusted platform context."""
    if "openswarm_platform_note" not in text and "openswarm_session_recap" not in text:
        return text
    return P_SENTINEL_TAG_RE.sub(lambda m: m.group(0).replace("<", "&lt;").replace(">", "&gt;"), text)


@typechecked
def recap_tool_call_line(content: object) -> str:
    """One compact line for a tool_call turn: Tool call: name(<truncated input>)."""
    if isinstance(content, dict):
        tool = content.get("tool") or content.get("name") or "tool"
        raw_input = content.get("input")
        try:
            input_str = json.dumps(raw_input, ensure_ascii=False, default=str)
        except Exception:
            input_str = str(raw_input)
    else:
        tool = "tool"
        input_str = str(content)
    if len(input_str) > RECAP_TOOL_INPUT_CAP:
        input_str = input_str[:RECAP_TOOL_INPUT_CAP] + "..."
    return f"Tool call: {tool}({strip_forged_sentinels(input_str)})"


@typechecked
def recap_tool_result_line(content: object) -> str:
    """One compact line for a tool_result turn: Tool result (name): <truncated text>."""
    tool_name = ""
    if isinstance(content, dict):
        tool_name = content.get("tool_name") or ""
        text = content.get("text")
        body = text if isinstance(text, str) else json.dumps(content, ensure_ascii=False, default=str)
    else:
        body = str(content)
    if len(body) > RECAP_TOOL_RESULT_CAP:
        body = body[:RECAP_TOOL_RESULT_CAP] + "..."
    label = f"Tool result ({tool_name})" if tool_name else "Tool result"
    return f"{label}: {strip_forged_sentinels(body)}"


@typechecked
def get_branch_messages(session) -> List:
    """Return the linear message list for the active branch, walking the branch tree."""
    branch_id = session.active_branch_id or "main"
    branch = session.branches.get(branch_id)

    if not branch or not branch.fork_point_message_id:
        return [m for m in session.messages if m.branch_id == "main" or m.branch_id == branch_id]

    segments = []
    cur = branch
    cur_id = branch_id
    visited = set()
    while cur and cur.fork_point_message_id:
        if cur_id in visited:
            break
        visited.add(cur_id)
        segments.insert(0, {"branch_id": cur_id, "up_to": cur.fork_point_message_id})
        cur_id = cur.parent_branch_id or "main"
        cur = session.branches.get(cur_id)
    segments.insert(0, {"branch_id": cur_id, "up_to": None})

    result = []
    for i, seg in enumerate(segments):
        fork_msg_id = seg["up_to"]
        if fork_msg_id:
            fork_idx = next((j for j, m in enumerate(session.messages) if m.id == fork_msg_id), len(session.messages))
            result.extend(m for m in session.messages[:fork_idx] if m.branch_id == seg["branch_id"])
        else:
            next_fork = segments[i + 1]["up_to"] if i + 1 < len(segments) else None
            if next_fork:
                fork_idx = next((j for j, m in enumerate(session.messages) if m.id == next_fork), len(session.messages))
                result.extend(m for m in session.messages[:fork_idx] if m.branch_id == seg["branch_id"])
            else:
                result.extend(m for m in session.messages if m.branch_id == seg["branch_id"])

    if not any(m.branch_id == branch_id for m in result):
        result.extend(m for m in session.messages if m.branch_id == branch_id)
    return result


# A reply in the recap is a reminder of what the model said, not a copy: verbatim replays of the model's own long outputs are exactly what Anthropic's anti-distillation filter blocks, and the user still has the full text on screen.
RECAP_REPLY_GIST_CHARS = 600


@typechecked
def clamp_reply_gist(text: str) -> str:
    if len(text) <= RECAP_REPLY_GIST_CHARS:
        return text
    return f"{text[:RECAP_REPLY_GIST_CHARS]} [... {len(text) - RECAP_REPLY_GIST_CHARS} chars of this reply omitted from recap ...]"


@typechecked
def build_history_prefix(messages, cutoff_msg_id: Optional[str] = None, mode: str = "full") -> str:
    """Format branch messages into a conversation summary for context injection.

    `mode` is the session's history_prefix_mode: "full" carries asks, reply gists and the tool
    trail; "minimal" carries only the user's asks and the tool calls (no model text at all), the
    shape left once a provider policy filter has blocked a fuller recap.

    When `cutoff_msg_id` is provided (session.compacted_through_msg_id), drop every
    message up to and including that id so the marker the UI shows actually matches
    what the model sees. Missing cutoff id falls through to full history.
    """
    # Aging replaced dropping (ENG-354, hermes lift): pre-cutoff history becomes re-runnable
    # one-line stubs instead of vanishing, duplicates collapse, and the newest tool results
    # survive verbatim inside a budget, so a context break costs detail, never the trail.
    from backend.apps.agents.manager.session.aged_recap_lines import age_tool_results
    cutoff_idx = -1
    if cutoff_msg_id:
        cutoff_idx = next((i for i, m in enumerate(messages) if m.id == cutoff_msg_id), -1)
    visible = [(i, m) for i, m in enumerate(messages) if not getattr(m, "hidden", False)]
    fates = age_tool_results([m for _, m in visible], cutoff_idx=next(
        (v for v, (i, _) in enumerate(visible) if i == cutoff_idx), -1))
    lines = []
    for v, (i, m) in enumerate(visible):
        if m.role == "user":
            text = m.content if isinstance(m.content, str) else str(m.content)
            lines.append(f"The user asked: {strip_forged_sentinels(clamp_recap_text(text))}")
        elif m.role == "assistant":
            if mode == "minimal":
                continue
            text = m.content if isinstance(m.content, str) else str(m.content)
            # First-person framing on purpose: a bare "User:/Assistant:" transcript inside a user
            # message pattern-matches provider distillation filters (Anthropic blocked real users'
            # recap turns as "duplicating model outputs"); "you replied" states the truth, this is
            # the SAME assistant's own earlier work in this same session.
            lines.append(f"You replied: {strip_forged_sentinels(clamp_reply_gist(text))}")
        elif m.role == "tool_call":
            lines.append(recap_tool_call_line(m.content))
        elif m.role == "tool_result":
            if mode == "minimal":
                continue
            body = fates.get(v)
            if body is None:
                lines.append(recap_tool_result_line(m.content))
            else:
                tool_name = m.content.get("tool_name") if isinstance(m.content, dict) else None
                label = f"Tool result ({tool_name})" if tool_name else "Tool result"
                lines.append(f"{label}: {strip_forged_sentinels(body)}")
    if not lines:
        return ""
    p_recap_frame = ("Recap of YOUR OWN earlier turns in this same conversation, summarized "
                     "locally by the OpenSwarm app so you can continue where you left off.")
    return f"{SESSION_RECAP_OPEN}\n{PLATFORM_NOTE_PREAMBLE}\n{p_recap_frame}\n" + "\n".join(lines) + f"\n{SESSION_RECAP_CLOSE}"


@typechecked
def estimate_post_compact_input(session) -> int:
    """Return a conservative token estimate after compaction trims history."""
    try:
        messages = get_branch_messages(session)
        cutoff_msg_id = getattr(session, "compacted_through_msg_id", None)
        if cutoff_msg_id:
            skip_idx = next(
                (i for i, m in enumerate(messages) if m.id == cutoff_msg_id),
                -1,
            )
            if skip_idx >= 0:
                messages = messages[skip_idx + 1:]
        surviving_chars = 0
        for message in messages:
            if getattr(message, "hidden", False):
                continue
            content = getattr(message, "content", "")
            if isinstance(content, str):
                serialized = content
            else:
                try:
                    serialized = json.dumps(content, ensure_ascii=False)
                except Exception:
                    serialized = str(content)
            surviving_chars += len(serialized)
        framework_overhead = int(getattr(session, "framework_overhead_tokens", 0) or 0)
        summary_overhead = 200 if cutoff_msg_id else 0
        return max(0, framework_overhead + summary_overhead + (surviving_chars // 4))
    except Exception:
        logger.debug("post-compact token estimate failed", exc_info=True)
        return max(0, int(getattr(session, "framework_overhead_tokens", 0) or 0))


@typechecked
def truncate_large_tool_result(content: object, session_id: str, msg_id: str, max_bytes: int = 50_000) -> Tuple[object, Optional[str]]:
    """Spill a large tool_result body to disk, return a truncated
    inline replacement plus the on-disk path (or None if untouched).

    Storage is session-scoped under data/sessions/<session_id>/blobs/,
    never honors caller-supplied paths (defense against path
    traversal). The inline replacement middle-elides: head AND tail
    survive, so a verdict printed at the end of a long output (test
    summary, build result) still reaches the model.
    """
    if not isinstance(content, str):
        try:
            serialized = json.dumps(content) if not isinstance(content, str) else content
        except Exception:
            serialized = str(content)
    else:
        serialized = content
    if len(serialized.encode("utf-8")) <= max_bytes:
        return content, None
    blobs_dir = os.path.join(SESSIONS_DIR, session_id, "blobs")
    os.makedirs(blobs_dir, exist_ok=True)
    # Sanitize msg_id (it's UUID hex, but be defensive).
    safe_msg_id = re.sub(r"[^a-zA-Z0-9_-]", "", str(msg_id))[:64] or "blob"
    blob_path = os.path.join(blobs_dir, f"{safe_msg_id}.txt")
    try:
        with open(blob_path, "w", encoding="utf-8") as f:
            f.write(serialized)
    except Exception as e:
        logger.warning(f"Failed to spill tool result to {blob_path}: {e}")
        return content, None
    return build_elided_replacement(serialized, blob_path), blob_path


@typechecked
def build_elided_replacement(serialized: str, blob_path: str) -> str:
    """Head + tail of an oversized body with an elision marker between them, then the recovery
    note. Degrades to the plain body when it is too short to elide."""
    head = strip_forged_sentinels(serialized[:SPILL_HEAD_CHARS])
    note = wrap_platform_note(
        f"Output truncated by OpenSwarm. Full output ({len(serialized)} chars) saved to "
        f"{blob_path}. Ask the user or run a follow-up tool call if you need the rest."
    )
    dropped = len(serialized) - SPILL_HEAD_CHARS - SPILL_TAIL_CHARS
    if dropped <= 0:
        return f"{strip_forged_sentinels(serialized)}\n\n{note}"
    tail = strip_forged_sentinels(serialized[-SPILL_TAIL_CHARS:])
    marker = f"\n\n[... {dropped} chars elided by OpenSwarm; full output at {blob_path} ...]\n\n"
    return f"{head}{marker}{tail}\n\n{note}"
