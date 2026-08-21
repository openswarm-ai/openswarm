"""The chat-history query: paginated, searchable summaries of every session, live ones included.
Read-only; split out of SessionLifecycle so that file keeps to lifecycle. self.sessions resolves
across the AgentManager MRO as before."""

from typing import Dict, Optional

from typeguard import typechecked

from backend.apps.agents.manager.session.session_store import load_all_session_data, build_search_text
from backend.apps.agents.manager.AgentManagerProtocol import AgentManagerProtocol

# Agent-spawned children, never a chat the user started, so they stay out of chat history.
P_NON_CHAT_MODES = {"browser-agent", "sub-agent", "invoked-agent", "app-agent"}


class SessionHistory(AgentManagerProtocol):
    @typechecked
    def get_history(
        self,
        q: str = "",
        limit: int = 20,
        offset: int = 0,
        dashboard_id: Optional[str] = None,
        closed_only: bool = False,
    ) -> Dict:
        """Return paginated, optionally filtered summaries of sessions, live ones included."""
        # A malformed file (a list, a bare string) would blow up data.get and 500 the whole endpoint.
        all_data = [pair for pair in load_all_session_data() if isinstance(pair[1], dict)]
        # Live sessions usually also have a disk copy (boot restore keeps the file), but the disk copy lags the turn in flight; memory wins the dedupe because it is never staler.
        in_memory = set(self.sessions.keys())
        all_data = [pair for pair in all_data if pair[0] not in in_memory and pair[1].get("id") not in in_memory]
        for sid, session in self.sessions.items():
            all_data.append((sid, {
                "id": sid,
                "name": session.name,
                "status": session.status,
                "model": session.model,
                "mode": session.mode,
                "created_at": session.created_at.isoformat() if session.created_at else None,
                "closed_at": None,
                "cost_usd": session.cost_usd,
                "dashboard_id": session.dashboard_id,
                "search_text": build_search_text(session),
            }))
        # Sort on last-activity, not closed_at: keying on closed_at alone sorted every live chat ("" ) below every finished one, i.e. off page 1.
        all_data.sort(key=lambda pair: str(pair[1].get("closed_at") or pair[1].get("created_at") or ""), reverse=True)

        q_lower = q.strip().lower()
        history = []
        for sid, data in all_data:
            # Children are machinery, not chats: a busy user's real history was buried under hundreds of "Browser Agent" rows.
            if data.get("mode") in P_NON_CHAT_MODES:
                continue
            # The boot fetch wants CLOSED sessions only: open ones landing in the client's history map made its resurrection gate swallow their terminal frames. Search keeps the full pool (open sessions on other dashboards are reachable nowhere else).
            if closed_only and not data.get("closed_at"):
                continue
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
