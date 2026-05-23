import json
import os

from backend.apps.agents.core.models import AgentSession


def _sessions_dir() -> str:
    # Resolve live so test patches on either the paths module or the
    # agent_manager facade re-export land on the same directory.
    from backend.apps.agents import agent_manager
    return agent_manager.SESSIONS_DIR


def _save_session(session_id: str, doc_data: dict):
    sessions_dir = _sessions_dir()
    os.makedirs(sessions_dir, exist_ok=True)
    with open(os.path.join(sessions_dir, f"{session_id}.json"), "w") as f:
        json.dump(doc_data, f, indent=2)


def _load_session_data(session_id: str) -> dict | None:
    path = os.path.join(_sessions_dir(), f"{session_id}.json")
    if not os.path.exists(path):
        return None
    with open(path) as f:
        return json.load(f)


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
            with open(os.path.join(sessions_dir, fname)) as f:
                results.append((fname[:-5], json.load(f)))
    return results


def build_search_text(session: AgentSession, max_len: int = 5000) -> str:
    """Build a search-indexing string from the session name and message content."""
    parts = [session.name or ""]
    for msg in session.messages:
        if msg.role in ("user", "assistant") and isinstance(msg.content, str):
            parts.append(msg.content)
    text = " ".join(parts)
    return text[:max_len]
