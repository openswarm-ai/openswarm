import os

from backend.apps.agents.core.models import AgentSession
from backend.config.json_store import read_json_or_none, atomic_write_json


def _sessions_dir() -> str:
    # Resolve live so test patches on either the paths module or the
    # agent_manager facade re-export land on the same directory.
    from backend.apps.agents import agent_manager
    return agent_manager.SESSIONS_DIR


def _save_session(session_id: str, doc_data: dict):
    sessions_dir = _sessions_dir()
    os.makedirs(sessions_dir, exist_ok=True)
    atomic_write_json(os.path.join(sessions_dir, f"{session_id}.json"), doc_data)


def _load_session_data(session_id: str) -> dict | None:
    return read_json_or_none(os.path.join(_sessions_dir(), f"{session_id}.json"))


def _delete_session_file(session_id: str):
    path = os.path.join(_sessions_dir(), f"{session_id}.json")
    if os.path.exists(path):
        os.remove(path)


def _load_all_session_data() -> list[tuple[str, dict]]:
    results = []
    sessions_dir = _sessions_dir()
    if not os.path.exists(sessions_dir):
        return results
    for fname in os.listdir(sessions_dir):
        if fname.endswith(".json"):
            data = read_json_or_none(os.path.join(sessions_dir, fname))
            if data is not None:
                results.append((fname[:-5], data))
    return results


def build_search_text(session: AgentSession, max_len: int = 5000) -> str:
    """Build a search-indexing string from the session name and message content."""
    parts = [session.name or ""]
    for msg in session.messages:
        if msg.role in ("user", "assistant") and isinstance(msg.content, str):
            parts.append(msg.content)
    text = " ".join(parts)
    return text[:max_len]
