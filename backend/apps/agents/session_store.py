"""Session persistence, history queries, and message-copying helpers.

Uses ``SessionStore`` from ``backend.apps.common.json_store`` for on-disk
JSON CRUD and exposes higher-level helpers consumed by ``AgentManager``.
"""

from __future__ import annotations

import logging
from datetime import datetime
from uuid import uuid4

from backend.apps.agents.models import AgentSession, Message, MessageBranch
from backend.apps.common.json_store import SessionStore
from backend.config.paths import SESSIONS_DIR

logger = logging.getLogger(__name__)

_session_store = SessionStore(SESSIONS_DIR)

save_session = _session_store.save
load_session_data = _session_store.load
delete_session_file = _session_store.delete
load_all_session_data = _session_store.load_all


def build_search_text(session: AgentSession, max_len: int = 5000) -> str:
    """Build a search-indexing string from session name and message content."""
    parts = [session.name or ""]
    for msg in session.messages:
        if msg.role in ("user", "assistant") and isinstance(msg.content, str):
            parts.append(msg.content)
    text = " ".join(parts)
    return text[:max_len]


def get_history(
    q: str = "",
    limit: int = 20,
    offset: int = 0,
    dashboard_id: str | None = None,
) -> dict:
    """Return paginated, optionally filtered summaries of closed sessions."""
    all_data = load_all_session_data()
    all_data.sort(key=lambda pair: pair[1].get("closed_at") or "", reverse=True)

    q_lower = q.strip().lower()
    history: list[dict] = []
    for sid, data in all_data:
        if dashboard_id and data.get("dashboard_id") != dashboard_id:
            continue
        if q_lower:
            name = (data.get("name") or "").lower()
            search_text = (data.get("search_text") or "").lower()
            if q_lower not in name and q_lower not in search_text:
                continue
        history.append({
            "id": data.get("id", sid),
            "name": data.get("name", "Untitled"),
            "status": data.get("status", "stopped"),
            "model": data.get("model", "sonnet"),
            "mode": data.get("mode", "agent"),
            "created_at": data.get("created_at"),
            "closed_at": data.get("closed_at"),
            "cost_usd": data.get("cost_usd", 0),
            "dashboard_id": data.get("dashboard_id"),
        })

    total = len(history)
    page = history[offset : offset + limit]
    return {
        "sessions": page,
        "total": total,
        "has_more": offset + limit < total,
    }


async def reconcile_on_startup() -> None:
    """Mark any stale running sessions as stopped."""
    for sid, data in load_all_session_data():
        if data.get("status") in ("running", "waiting_approval"):
            data["status"] = "stopped"
            save_session(sid, data)
            logger.info(f"Marked stale session {sid} as stopped")


def get_browser_agent_children(
    sessions: dict[str, AgentSession],
    parent_session_id: str,
) -> list[dict]:
    """Return browser-agent sessions for a parent, from memory or disk."""
    results: list[dict] = []
    seen: set[str] = set()

    for s in sessions.values():
        if s.mode == "browser-agent" and s.parent_session_id == parent_session_id:
            results.append(s.model_dump(mode="json"))
            seen.add(s.id)

    for sid, data in load_all_session_data():
        if sid in seen:
            continue
        if data.get("mode") == "browser-agent" and data.get("parent_session_id") == parent_session_id:
            results.append(data)

    return results


def copy_session_messages(
    source: AgentSession,
    up_to_message_id: str | None = None,
) -> tuple[list[Message], dict[str, MessageBranch], dict[str, str]]:
    """Deep-copy messages and branches from *source*, returning new IDs.

    Returns ``(new_messages, new_branches, old_to_new_msg_id_map)``.
    """
    source_messages = list(source.messages)
    if up_to_message_id:
        cut_idx = next(
            (i for i, m in enumerate(source_messages) if m.id == up_to_message_id),
            None,
        )
        if cut_idx is not None:
            source_messages = source_messages[: cut_idx + 1]

    old_to_new: dict[str, str] = {}
    new_messages: list[Message] = []
    for msg in source_messages:
        new_id = uuid4().hex
        old_to_new[msg.id] = new_id
        new_messages.append(Message(
            id=new_id,
            role=msg.role,
            content=msg.content,
            timestamp=msg.timestamp,
            branch_id=msg.branch_id,
            parent_id=old_to_new.get(msg.parent_id) if msg.parent_id else None,
            context_paths=msg.context_paths,
            attached_skills=msg.attached_skills,
            forced_tools=msg.forced_tools,
            images=msg.images,
        ))

    new_branches: dict[str, MessageBranch] = {}
    for bid, branch in source.branches.items():
        new_branches[bid] = MessageBranch(
            id=bid,
            parent_branch_id=branch.parent_branch_id,
            fork_point_message_id=(
                old_to_new.get(branch.fork_point_message_id)
                if branch.fork_point_message_id else None
            ),
            created_at=branch.created_at,
        )

    return new_messages, new_branches, old_to_new
