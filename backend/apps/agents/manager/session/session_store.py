import os

from backend.apps.agents.core.models import AgentSession
from typing import Dict, List, Optional, Tuple
from typeguard import typechecked
from backend.config.json_store import read_json_or_none, atomic_write_json


@typechecked
def sessions_dir() -> str:
    # Resolve live so test patches on either the paths module or the agent_manager facade re-export land on the same directory.
    from backend.apps.agents import agent_manager
    return agent_manager.SESSIONS_DIR


@typechecked
def save_session(session_id: str, doc_data: Dict) -> None:
    dir_path = sessions_dir()
    os.makedirs(dir_path, exist_ok=True)
    atomic_write_json(os.path.join(dir_path, f"{session_id}.json"), doc_data)


@typechecked
def load_session_data(session_id: str) -> Optional[Dict]:
    return read_json_or_none(os.path.join(sessions_dir(), f"{session_id}.json"))


@typechecked
def delete_session_file(session_id: str) -> None:
    path = os.path.join(sessions_dir(), f"{session_id}.json")
    if os.path.exists(path):
        os.remove(path)


@typechecked
def load_all_session_data() -> List[Tuple[str, Dict]]:
    results = []
    dir_path = sessions_dir()
    if not os.path.exists(dir_path):
        return results
    for fname in os.listdir(dir_path):
        if fname.endswith(".json"):
            data = read_json_or_none(os.path.join(dir_path, fname))
            if data is not None:
                results.append((fname[:-5], data))
    return results


@typechecked
def build_search_text(session: AgentSession, max_len: int = 5000) -> str:
    """Build a search-indexing string from the session name and message content."""
    parts = [session.name or ""]
    for msg in session.messages:
        if msg.role in ("user", "assistant") and isinstance(msg.content, str):
            parts.append(msg.content)
    text = " ".join(parts)
    return text[:max_len]


@typechecked
def snapshot_session_now(session: AgentSession) -> None:
    """Write the session to disk immediately, swallowing failure. Called the moment a user message
    is appended: sessions used to reach disk only at turn END, so a backend death mid-turn destroyed
    the whole conversation (404, zero bytes) if it was the first turn, and ate the turn's user
    message otherwise (ENG-313). One bounded whole-file write per send, same cost as the existing
    end-of-turn save; a disk hiccup must never break the send itself."""
    try:
        doc = session.model_dump(mode="json")
        doc["search_text"] = build_search_text(session)
        save_session(session.id, doc)
    except Exception:
        import logging
        logging.getLogger(__name__).warning("snapshot_session_now failed for %s", session.id, exc_info=True)
