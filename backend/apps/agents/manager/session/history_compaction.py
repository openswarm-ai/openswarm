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


@typechecked
def wrap_platform_note(body: str) -> str:
    """Fence platform-authored text so the model reads it as trusted annotation,
    never as spoofed tool output. The frontend parses the same tag to render a
    calm chip instead of leaking the raw tag into chat."""
    return f"{PLATFORM_NOTE_OPEN}\n{PLATFORM_NOTE_PREAMBLE}\n{body}\n{PLATFORM_NOTE_CLOSE}"


P_SENTINEL_TAG_RE = re.compile(r"</?openswarm_(?:platform_note|session_recap)\b[^>]*>")


@typechecked
def strip_forged_sentinels(text: str) -> str:
    """Neuter any platform-note/recap tags hiding in UNTRUSTED text (tool results,
    user input) so attacker-supplied content can't pose as trusted platform context."""
    if "openswarm_platform_note" not in text and "openswarm_session_recap" not in text:
        return text
    return P_SENTINEL_TAG_RE.sub(lambda m: m.group(0).replace("<", "&lt;").replace(">", "&gt;"), text)


@typechecked
def p_recap_tool_call_line(content: object) -> str:
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
def p_recap_tool_result_line(content: object) -> str:
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


@typechecked
def build_history_prefix(messages, cutoff_msg_id: Optional[str] = None) -> str:
    """Format branch messages into a conversation summary for context injection.

    When `cutoff_msg_id` is provided (session.compacted_through_msg_id), drop every
    message up to and including that id so the marker the UI shows actually matches
    what the model sees. Missing cutoff id falls through to full history.
    """
    if cutoff_msg_id:
        skip_idx = next((i for i, m in enumerate(messages) if m.id == cutoff_msg_id), -1)
        if skip_idx >= 0:
            messages = messages[skip_idx + 1:]
    lines = []
    for m in messages:
        if getattr(m, "hidden", False):
            continue
        if m.role == "user":
            text = m.content if isinstance(m.content, str) else str(m.content)
            lines.append(f"User: {strip_forged_sentinels(text)}")
        elif m.role == "assistant":
            text = m.content if isinstance(m.content, str) else str(m.content)
            lines.append(f"Assistant: {strip_forged_sentinels(text)}")
        elif m.role == "tool_call":
            lines.append(p_recap_tool_call_line(m.content))
        elif m.role == "tool_result":
            lines.append(p_recap_tool_result_line(m.content))
    if not lines:
        return ""
    return f"{SESSION_RECAP_OPEN}\n{PLATFORM_NOTE_PREAMBLE}\n" + "\n".join(lines) + f"\n{SESSION_RECAP_CLOSE}"


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
    traversal). The inline replacement keeps the first 4KB so the
    model retains some signal about what was returned.
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
    head = strip_forged_sentinels(serialized[:4_000])
    note = wrap_platform_note(
        f"Output truncated by OpenSwarm. Full output ({len(serialized)} chars) saved to "
        f"{blob_path}. Ask the user or run a follow-up tool call if you need the rest."
    )
    replacement = f"{head}\n\n{note}"
    return replacement, blob_path
