import json
import logging
import os
import re
from typing import Iterable

from backend.config.paths import SESSIONS_DIR

logger = logging.getLogger(__name__)


# Importance scoring weights (higher = more important)
_DEFAULT_IMPORTANCE = {
    "user_requirements": 10,
    "architecture_decision": 9,
    "error_log": 8,
    "generated_code": 7,
    "file_path": 9,
    "todo": 9,
    "greeting": 1,
}


def _extract_text(msg) -> str:
    if isinstance(msg.content, str):
        return msg.content
    try:
        # content may be list/blocks
        return json.dumps(msg.content)
    except Exception:
        return str(msg.content)


def _has_code_block(text: str) -> bool:
    return bool(re.search(r"```|\n\s{4,}", text))


def _has_file_path(text: str) -> bool:
    # crude but practical: windows drive, unix absolute, or filename.ext
    if re.search(r"[A-Za-z]:\\\\|/\w|\./|\.\w{1,6}\b", text):
        return True
    return False


def _is_todo(text: str) -> bool:
    return bool(re.search(r"\b(TODO|FIXME|TO DO|to do)\b", text, re.I))


def _is_decision(text: str) -> bool:
    return bool(re.search(r"\b(decision|decide|we will|we'll|plan|architecture|architectural)\b", text, re.I))


def _is_error_log(text: str) -> bool:
    return bool(re.search(r"traceback|exception|stack trace|error:\s|\bERROR\b", text, re.I))


def _is_greeting(text: str) -> bool:
    return bool(re.search(r"\b(hello|hi\b|hey\b|good morning|good afternoon|thanks|thank you)\b", text, re.I))


def _score_message(msg) -> int:
    text = _extract_text(msg)
    score = 0
    # Role boosts
    if getattr(msg, "role", "") == "user":
        score = max(score, 5)
    if getattr(msg, "role", "") == "assistant":
        score = max(score, 3)

    if _is_todo(text):
        score = max(score, _DEFAULT_IMPORTANCE["todo"])
    if _is_decision(text):
        score = max(score, _DEFAULT_IMPORTANCE["architecture_decision"])
    if _is_error_log(text):
        score = max(score, _DEFAULT_IMPORTANCE["error_log"])
    if _has_code_block(text):
        score = max(score, _DEFAULT_IMPORTANCE["generated_code"])
    if _has_file_path(text):
        score = max(score, _DEFAULT_IMPORTANCE["file_path"])
    if _is_greeting(text):
        score = max(score, _DEFAULT_IMPORTANCE["greeting"])

    # Detect explicit requirements wording
    if re.search(r"\b(requirement|requirements|must\s+have|must\s+be|should\s+be|need to|acceptance criteria)\b", text, re.I):
        score = max(score, _DEFAULT_IMPORTANCE["user_requirements"])

    # Small length heuristic: very short chit-chat likely low importance
    if len(text) < 40 and score < 3:
        score = min(score, 1)

    return int(score)


def _summarize_messages_segment(msgs: Iterable, max_snippets: int = 3) -> str:
    """Create a short summary for a sequence of low-importance messages."""
    snippets = []
    for m in msgs:
        t = _extract_text(m).strip()
        if not t:
            continue
        # pick lines that are short and informative
        lines = [l.strip() for l in t.splitlines() if l.strip()]
        if lines:
            snippets.append(lines[0][:240])
        else:
            snippets.append(t[:240])
        if len(snippets) >= max_snippets:
            break
    if not snippets:
        return "(several short messages compressed)"
    joined = " | ".join(snippets)
    return f"(compressed {len(list(msgs))} messages): {joined}"



def _get_branch_messages(session) -> list:
    """Return the linear message list for the active branch, walking the branch tree."""
    branch_id = session.active_branch_id or "main"
    branch = session.branches.get(branch_id)

    if not branch or not branch.fork_point_message_id:
        # No branching: linear main/active-branch result
        result = [m for m in session.messages if m.branch_id == "main" or m.branch_id == branch_id]
    else:
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
    # Apply compaction if session has a compacted_through_msg_id set.
    try:
        compact_id = getattr(session, "compacted_through_msg_id", None)
        if compact_id:
            # find index in result for compact_id
            idx = next((i for i, m in enumerate(result) if m.id == compact_id), None)
            if idx is not None and idx >= 0:
                # Messages at or before idx are candidates for compaction.
                older = result[: idx + 1]
                newer = result[idx + 1 :]

                # Branch-aware: preserve fork points and any message explicitly
                # referenced as a fork_point_message_id for any branch.
                critical_ids = set()
                for b in getattr(session, "branches", {}).values():
                    if getattr(b, "fork_point_message_id", None):
                        critical_ids.add(b.fork_point_message_id)

                # Score messages and decide which to keep verbatim.
                keep = []
                buffer = []
                from backend.apps.agents.core.models import Message as _Message

                def flush_buffer():
                    nonlocal keep, buffer
                    if not buffer:
                        return
                    summary_text = _summarize_messages_segment(buffer)
                    # create a synthetic assistant message to preserve summary
                    summary_msg = _Message(role="assistant", content=summary_text, branch_id=branch_id)
                    keep.append(summary_msg)
                    buffer = []

                for m in older:
                    # Preserve hidden/tool/system messages as-is
                    if getattr(m, "hidden", False) or m.role not in ("user", "assistant"):
                        flush_buffer()
                        keep.append(m)
                        continue
                    if getattr(m, "id", None) in critical_ids:
                        flush_buffer()
                        keep.append(m)
                        continue
                    score = _score_message(m)
                    # Preserve high-importance items (architecture, requirements,
                    # error logs, code blocks, file paths, TODOs).
                    if score >= 7:
                        flush_buffer()
                        keep.append(m)
                    else:
                        # low-importance: buffer for summarization
                        buffer.append(m)
                flush_buffer()

                result = keep + newer
    except Exception:
        logger.exception("history compaction failed; returning un-compacted branch list")
    return result


def _build_history_prefix(messages, cutoff_msg_id: str | None = None) -> str:
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
        if m.role not in ("user", "assistant") or getattr(m, "hidden", False):
            continue
        text = m.content if isinstance(m.content, str) else str(m.content)
        label = "User" if m.role == "user" else "Assistant"
        lines.append(f"{label}: {text}")
    if not lines:
        return ""
    return "<prior_conversation>\n" + "\n".join(lines) + "\n</prior_conversation>"


def _truncate_large_tool_result(content: object, session_id: str, msg_id: str, max_bytes: int = 50_000) -> tuple[object, str | None]:
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
    head = serialized[:4_000]
    replacement = (
        f"{head}\n\n"
        f"[truncated, full output ({len(serialized)} chars) saved to {blob_path}. "
        f"Ask the user or run a follow-up tool call if you need the rest.]"
    )
    return replacement, blob_path
