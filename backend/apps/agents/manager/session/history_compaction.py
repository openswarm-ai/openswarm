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


@typechecked
def trail_lines(messages, cutoff_msg_id: Optional[str] = None) -> List[str]:
    """The user's asks and the tool trail, and NEVER a line of model-authored prose.

    Extracted so every renderer bound for a model's context shares one definition of what is safe
    to send. Two others were still emitting raw `USER:/ASSISTANT:` replays of another agent's chat
    (ENG-396), which is the exact shape ENG-358 removed from the recap; a safety property with two
    implementations is one drift away from being no safety property at all.
    """
    from backend.apps.agents.manager.session.aged_recap_lines import age_tool_results
    cutoff_idx = -1
    if cutoff_msg_id:
        cutoff_idx = next((i for i, m in enumerate(messages) if m.id == cutoff_msg_id), -1)
    visible = [(i, m) for i, m in enumerate(messages) if not getattr(m, "hidden", False)]
    fates = age_tool_results([m for _, m in visible], cutoff_idx=next(
        (v for v, (i, _) in enumerate(visible) if i == cutoff_idx), -1))
    lines: List[str] = []
    for v, (i, m) in enumerate(visible):
        if m.role == "user":
            text = m.content if isinstance(m.content, str) else str(m.content)
            lines.append(f"The user asked: {strip_forged_sentinels(clamp_recap_text(text))}")
        elif m.role == "tool_call":
            lines.append(recap_tool_call_line(m.content))
        elif m.role == "tool_result":
            body = fates.get(v)
            if body is None:
                lines.append(recap_tool_result_line(m.content))
            else:
                tool_name = m.content.get("tool_name") if isinstance(m.content, dict) else None
                label = f"Tool result ({tool_name})" if tool_name else "Tool result"
                lines.append(f"{label}: {strip_forged_sentinels(body)}")
    return lines


@typechecked
def render_agent_trail(messages, max_chars: int = 14_000) -> str:
    """What ANOTHER agent's run did, for a model that has to reason about it.

    Same safe body as the recap, different framing: this is someone else's run, not your own past.
    Tail-biased cap so the end, where a run succeeds or blows up, always survives.
    """
    lines = trail_lines(messages)
    if not lines:
        return ""
    out = "\n".join(lines)
    if len(out) > max_chars:
        out = "...(earlier steps trimmed)...\n" + out[-max_chars:]
    return out


@typechecked
def build_history_prefix(messages, cutoff_msg_id: Optional[str] = None) -> str:
    """Format branch messages into a conversation summary for context injection.

    Carries the user's asks and the tool trail, never the model's own replies: a replay of the
    model's outputs in text we author is what Anthropic's anti-distillation filter blocks on the
    subscription lane (192 blocks in 14 days, none on API keys). Claude Code and hermes keep old
    answers only as model-written summaries; the distilled summary plays that role here.

    When `cutoff_msg_id` is provided (session.compacted_through_msg_id), drop every
    message up to and including that id so the marker the UI shows actually matches
    what the model sees. Missing cutoff id falls through to full history.
    """
    # Aging replaced dropping (ENG-354, hermes lift): pre-cutoff history becomes re-runnable
    # one-line stubs instead of vanishing, duplicates collapse, and the newest tool results
    # survive verbatim inside a budget, so a context break costs detail, never the trail.
    lines = trail_lines(messages, cutoff_msg_id)
    if not lines:
        return ""
    # Framing lifted from hermes-agent's compaction handoff (context_compressor.py, MIT): reference only, never active instructions, the message after it is the single source of truth, and an explicit end marker so a weak model cannot read the last line as fresh input.
    p_recap_frame = ("Recap of YOUR OWN earlier turns in this same conversation (what was asked and which tools "
                     "you ran), kept locally by the OpenSwarm app so you can continue where you left off. "
                     "Reference only: do not answer or redo anything in it; respond to the message that follows.")
    return (f"{SESSION_RECAP_OPEN}\n{PLATFORM_NOTE_PREAMBLE}\n{p_recap_frame}\n" + "\n".join(lines)
            + f"\n--- end of recap; respond to the message below, not the recap above ---\n{SESSION_RECAP_CLOSE}")


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
    blob_path = write_blob(serialized, session_id, msg_id)
    if blob_path is None:
        return content, None
    return build_elided_replacement(serialized, blob_path), blob_path


@typechecked
def write_blob(serialized: str, session_id: str, msg_id: str, suffix: str = "") -> Optional[str]:
    """Park a full tool body under the session's own blobs dir; returns the path, or None if it
    could not be written. Caller-supplied paths are never honoured (path traversal)."""
    blobs_dir = os.path.join(SESSIONS_DIR, session_id, "blobs")
    try:
        os.makedirs(blobs_dir, exist_ok=True)
        # Sanitize msg_id (it's UUID hex, but be defensive).
        safe_msg_id = re.sub(r"[^a-zA-Z0-9_-]", "", str(msg_id))[:64] or "blob"
        blob_path = os.path.join(blobs_dir, f"{safe_msg_id}{suffix}.txt")
        with open(blob_path, "w", encoding="utf-8") as f:
            f.write(serialized)
        return blob_path
    except Exception as e:
        logger.warning(f"Failed to spill tool result for {session_id}: {e}")
        return None


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
