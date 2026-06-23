"""Session lifecycle + query methods for AgentManager, split out as a mixin so the manager
file stays under the size ceiling. Pure relocation: every method reaches self.sessions /
self.tasks / self.stop_agent across the MRO exactly as it did inline, so behavior is identical."""

import asyncio
import logging
import os
from datetime import datetime
from typing import Optional

from backend.apps.agents.core.models import AgentSession
from backend.apps.agents.core.ws_manager import ws_manager
from backend.apps.agents.manager.session.session_store import (
    _delete_session_file,
    _load_all_session_data,
    _save_session,
    build_search_text,
)
from backend.apps.agents.manager.session.cloud_sync import _sync_session_close
from backend.apps.agents.manager.session.apply_context_window import apply_context_window
from backend.apps.agents.manager.session import lifecycle
from backend.apps.agents.manager.view_builder_state import (
    view_builder_render_retry_counts,
    view_builder_dirty_sessions,
)

logger = logging.getLogger(__name__)


class SessionLifecycleMixin:
    @staticmethod
    def _build_search_text(session: AgentSession, max_len: int = 5000) -> str:
        return build_search_text(session, max_len)

    def _sync_session_close(self, session: AgentSession, close_reason: str = "user"):
        _sync_session_close(session, close_reason)

    async def close_session(self, session_id: str) -> None:
        """Close a session: pause the agent if running, persist to JSON file,
        and remove from in-memory state. Also stops browser-agent children."""
        children = [
            s for s in self.sessions.values()
            if s.parent_session_id == session_id and s.mode == "browser-agent"
        ]
        for child in children:
            await self.stop_agent(child.id)

        task = self.tasks.get(session_id)
        if task and not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

        session = self.sessions.get(session_id)
        if not session:
            raise ValueError(f"Session {session_id} not found")

        if session.status in ("running", "waiting_approval"):
            session.status = "stopped"
        session.closed_at = datetime.now()

        for req in list(session.pending_approvals):
            ws_manager.resolve_approval(req.id, {"behavior": "deny", "message": "Session closed"})
        session.pending_approvals = []

        if hasattr(session, '_cancel_event'):
            session._cancel_event.set()

        self._sync_session_close(session)

        doc_data = session.model_dump(mode="json")
        doc_data["search_text"] = self._build_search_text(session)

        _save_session(session_id, doc_data)

        await ws_manager.send_to_session(session_id, "agent:closed", {
            "session_id": session_id,
            "status": session.status,
            "name": session.name,
            "model": session.model,
            "mode": session.mode,
            "created_at": session.created_at.isoformat() if session.created_at else None,
            "closed_at": session.closed_at.isoformat() if session.closed_at else None,
            "cost_usd": session.cost_usd,
            "dashboard_id": session.dashboard_id,
        })

        self._purge_session_memory(session_id)
        logger.info(f"Session {session_id} closed and persisted")

    def _purge_session_memory(self, session_id: str) -> None:
        """Drop a session from EVERY in-memory structure keyed by its id, so a
        close or delete can't strand stale per-session state that lives until
        the process dies. One chokepoint on purpose: a new per-session cache
        wires its eviction in HERE and both removal paths get it for free."""
        self.sessions.pop(session_id, None)
        self.tasks.pop(session_id, None)
        self._live_partial.pop(session_id, None)
        view_builder_render_retry_counts.pop(session_id, None)
        view_builder_dirty_sessions.discard(session_id)

    async def delete_session(self, session_id: str) -> None:
        """Permanently delete a session: remove from memory and JSON file.
        Also stops browser-agent children first."""
        children = [
            s for s in self.sessions.values()
            if s.parent_session_id == session_id and s.mode == "browser-agent"
        ]
        for child in children:
            await self.stop_agent(child.id)

        task = self.tasks.get(session_id)
        if task and not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

        self._purge_session_memory(session_id)

        _delete_session_file(session_id)
        logger.info(f"Session {session_id} permanently deleted")

    async def resume_session(self, session_id: str) -> AgentSession:
        if session_id in self.sessions:
            return self.sessions[session_id]
        session = lifecycle.load_session_for_resume(session_id)
        self.sessions[session_id] = session
        await ws_manager.send_to_session(session_id, "agent:status", {
            "session_id": session_id,
            "status": session.status,
            "session": session.model_dump(mode="json"),
        })
        logger.info(f"Session {session_id} resumed from history")
        return session

    def get_history(
        self,
        q: str = "",
        limit: int = 20,
        offset: int = 0,
        dashboard_id: str | None = None,
    ) -> dict:
        """Return paginated, optionally filtered summaries of closed sessions."""
        all_data = _load_all_session_data()
        all_data.sort(key=lambda pair: pair[1].get("closed_at") or "", reverse=True)

        q_lower = q.strip().lower()
        history = []
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

    async def reconcile_on_startup(self) -> None:
        """Mark any stale running sessions as stopped."""
        for sid, data in _load_all_session_data():
            dirty = False
            if data.get("status") in ("running", "waiting_approval"):
                data["status"] = "stopped"
                dirty = True
                logger.info(f"Marked stale session {sid} as stopped")
            # Mode migration: Chat was merged into Ask. Rewrite mode="chat"
            # so old sessions keep loading after the chat.json file is gone.
            if data.get("mode") == "chat":
                data["mode"] = "ask"
                dirty = True
            if dirty:
                _save_session(sid, data)

    async def persist_all_sessions(self) -> None:
        """Flush every in-memory session to JSON files (for graceful shutdown)."""
        for session_id, session in list(self.sessions.items()):
            if session.status in ("running", "waiting_approval"):
                session.status = "stopped"
            session.closed_at = None
            for req in list(session.pending_approvals):
                ws_manager.resolve_approval(req.id, {"behavior": "deny", "message": "Server shutting down"})
            session.pending_approvals = []
            # Tag this close as "shutdown" so the cloud can tell it apart
            # from a user-initiated close. The desktop doesn't care; the
            # tag rides along in the dump for whoever consumes it.
            self._sync_session_close(session, close_reason="shutdown")
            doc_data = session.model_dump(mode="json")
            doc_data["search_text"] = self._build_search_text(session)
            _save_session(session_id, doc_data)
            logger.info(f"Persisted session {session_id} on shutdown")
        self.sessions.clear()
        self.tasks.clear()

    async def restore_all_sessions(self) -> None:
        """On startup, reload all persisted sessions from JSON files back into memory.

        Only sessions without closed_at are restored (they were active at
        shutdown).  Sessions with closed_at were explicitly closed by the user
        and stay on disk so the history endpoint can still serve them.
        """
        for sid, data in _load_all_session_data():
            try:
                session = AgentSession(**data)
            except Exception as e:
                logger.warning(f"Skipping corrupt session file {sid}: {e}")
                continue
            if session.closed_at is not None:
                continue
            if session.status in ("running", "waiting_approval"):
                session.status = "stopped"
            session.pending_approvals = []
            apply_context_window(session)
            self.sessions[session.id] = session
            _delete_session_file(sid)
            logger.info(f"Restored session {session.id}")

    async def duplicate_session(self, session_id: str, dashboard_id: str | None = None, up_to_message_id: str | None = None) -> AgentSession:
        new_session = lifecycle.build_duplicate_session(self.sessions.get(session_id), session_id, dashboard_id, up_to_message_id)
        self.sessions[new_session.id] = new_session
        await ws_manager.send_to_session(new_session.id, "agent:status", {
            "session_id": new_session.id,
            "status": new_session.status,
            "session": new_session.model_dump(mode="json"),
        })
        return new_session

    def get_all_sessions(self, dashboard_id: str | None = None) -> list[AgentSession]:
        if not dashboard_id:
            return list(self.sessions.values())
        # Memory first, then promote on-disk sessions for this dashboard, but
        # ONLY ones the dashboard's layout still has a card for. A session keeps
        # its dashboard_id when its card is deleted, so promoting by tag alone
        # resurrected deleted chats on every reopen; the layout's cards are the
        # real source of truth for what's on the board. Imported sessions ARE in
        # the layout, so they still surface, and this bounds the disk read to
        # once per session per run, like resume_session.
        result = [s for s in self.sessions.values() if s.dashboard_id == dashboard_id]
        seen = {s.id for s in result}
        card_ids = self._dashboard_card_ids(dashboard_id)
        for sid, data in _load_all_session_data():
            if sid in seen or sid not in card_ids:
                continue
            if data.get("dashboard_id") != dashboard_id:
                continue
            try:
                sess = AgentSession(**data)
            except Exception:
                logger.warning(f"get_all_sessions: skipping unloadable session {sid}", exc_info=True)
                continue
            apply_context_window(sess)
            self.sessions[sid] = sess
            result.append(sess)
        return result

    def _dashboard_card_ids(self, dashboard_id: str) -> set[str]:
        """Session ids the dashboard's layout currently has agent cards for.
        Read straight off disk (no dashboards-module import, avoids a cycle)."""
        try:
            import os
            import backend.config.paths as _paths
            from backend.config.json_store import read_json_or_none
            d = read_json_or_none(os.path.join(_paths.DASHBOARDS_DIR, f"{dashboard_id}.json")) or {}
            return set((d.get("layout", {}).get("cards") or {}).keys())
        except Exception:
            return set()

    def get_session(self, session_id: str) -> Optional[AgentSession]:
        return self.sessions.get(session_id)

    def get_browser_agent_children(self, parent_session_id: str) -> list[dict]:
        """Return browser-agent sessions for a parent, from memory or disk."""
        results: list[dict] = []
        seen: set[str] = set()

        for s in self.sessions.values():
            if s.mode == "browser-agent" and s.parent_session_id == parent_session_id:
                results.append(s.model_dump(mode="json"))
                seen.add(s.id)

        for sid, data in _load_all_session_data():
            if sid in seen:
                continue
            if data.get("mode") == "browser-agent" and data.get("parent_session_id") == parent_session_id:
                results.append(data)

        return results

