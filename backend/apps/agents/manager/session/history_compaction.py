import json
import logging
import os
import re

from backend.config.paths import SESSIONS_DIR

logger = logging.getLogger(__name__)


def _get_branch_messages(session) -> list:
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


def _build_history_prefix(messages) -> str:
    """Format branch messages into a conversation summary for context injection."""
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
