"""On-disk JSON persistence for agent sessions.

Each session is stored as {session_id}.json in SESSIONS_DIR.
The agents subapp calls these functions during close/resume/startup/shutdown.
"""

import json
import os
from typing import List, Tuple, Optional
from backend.config.paths import DB_ROOT
from typeguard import typechecked

SESSIONS_DIR = os.path.join(DB_ROOT, "sessions")

@typechecked
def p_path(session_id: str) -> str:
    return os.path.join(SESSIONS_DIR, f"{session_id}.json")


@typechecked
def save(session_id: str, data: dict) -> None:
    os.makedirs(SESSIONS_DIR, exist_ok=True)
    with open(p_path(session_id), "w") as f:
        json.dump(data, f, indent=2)


@typechecked
def load(session_id: str) -> Optional[dict]:
    path: str = p_path(session_id)
    if not os.path.exists(path):
        return None
    with open(path) as f:
        return json.load(f)


@typechecked
def delete(session_id: str) -> None:
    path: str = p_path(session_id)
    if os.path.exists(path):
        os.remove(path)


# TODO: better type spec for the dict type
@typechecked
def load_all() -> List[Tuple[str, dict]]:
    results: List[Tuple[str, dict]] = []
    if not os.path.exists(SESSIONS_DIR):
        return results
    for fname in os.listdir(SESSIONS_DIR):
        if fname.endswith(".json"):
            try:
                with open(os.path.join(SESSIONS_DIR, fname)) as f:
                    results.append((fname[:-5], json.load(f)))
            except (json.JSONDecodeError, OSError) as e:
                print(f"[session_store.load_all] Skipping corrupt session file {fname}: {e}")
    return results


# TODO: better type spec for the whole damn thing
@typechecked
def build_search_text(agent_data: dict, max_len: int = 5000) -> str:
    parts = [agent_data.get("name", "")]
    for msg in agent_data.get("messages", {}).get("messages", []):
        role = msg.get("role")
        content = msg.get("content")
        if role in ("user", "assistant") and isinstance(content, str):
            parts.append(content)
    return " ".join(parts)[:max_len]

# TODO: all the dict get guesswork shld be swapped to smthn less ambiguous/guessy
@typechecked
def get_history(
    q: str = "",
    limit: int = 20,
    offset: int = 0,
    dashboard_id: Optional[str] = None,
) -> dict:
    all_data: List[Tuple[str, dict]] = load_all()
    all_data.sort(key=lambda pair: pair[1].get("closed_at") or "", reverse=True)

    q_lower: str = q.strip().lower()
    history: List[dict] = []
    for sid, data in all_data:
        if dashboard_id and data.get("dashboard_id") != dashboard_id:
            continue
        if q_lower:
            name: str = (data.get("name") or "").lower()
            search_text: str = (data.get("search_text") or "").lower()
            if q_lower not in name and q_lower not in search_text:
                continue
        history.append({
            "id": data.get("session_id", sid),
            "name": data.get("name", "Untitled"),
            "status": data.get("status", "stopped"),
            "model": data.get("model", "sonnet"),
            "mode": data.get("mode", "agent"),
            "created_at": data.get("created_at"),
            "closed_at": data.get("closed_at"),
            "cost_usd": data.get("cost_usd", 0),
            "dashboard_id": data.get("dashboard_id"),
        })

    total: int = len(history)
    page: List[dict] = history[offset : offset + limit]
    return {"sessions": page, "total": total, "has_more": offset + limit < total}


@typechecked
async def reconcile_on_startup() -> None:
    for sid, data in load_all():
        if data.get("status") in ("running", "waiting_approval"):
            data["status"] = "stopped"
            save(sid, data)
            print(f"[session_store.reconcile_on_startup] Marked stale session {sid} as stopped")