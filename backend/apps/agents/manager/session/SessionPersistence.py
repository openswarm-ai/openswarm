"""Bulk session persistence across the WHOLE store, the startup/shutdown orchestration that
operates on every session at once (reconcile stale-running, flush-all on shutdown, restore-all
on boot). Split from SessionLifecycle (which handles ONE session at a time) so each file is
one concern. self.sessions / self.sync_session_close resolve across the MRO as before."""

import logging

from typeguard import typechecked

from backend.apps.agents.core.models import AgentSession
from backend.apps.agents.core.ws_manager import ws_manager
from backend.apps.agents.manager.session.session_store import (
    delete_session_file,
    load_all_session_data,
    save_session,
)
from backend.apps.agents.manager.session.apply_context_window import apply_context_window

logger = logging.getLogger(__name__)


from backend.apps.agents.manager.AgentManagerProtocol import AgentManagerProtocol


class SessionPersistence(AgentManagerProtocol):
    @typechecked
    async def reconcile_on_startup(self) -> None:
        """Mark any stale running sessions as stopped."""
        for sid, data in load_all_session_data():
            dirty = False
            if data.get("status") in ("running", "waiting_approval"):
                data["status"] = "stopped"
                dirty = True
                logger.info(f"Marked stale session {sid} as stopped")
            # Mode migration: Chat was merged into Ask. Rewrite mode="chat" so old sessions keep loading after the chat.json file is gone.
            if data.get("mode") == "chat":
                data["mode"] = "ask"
                dirty = True
            if dirty:
                save_session(sid, data)

    @typechecked
    async def persist_all_sessions(self) -> None:
        """Flush every in-memory session to JSON files (for graceful shutdown)."""
        for session_id, session in list(self.sessions.items()):
            if session.status in ("running", "waiting_approval"):
                session.status = "stopped"
            session.closed_at = None
            for req in list(session.pending_approvals):
                ws_manager.resolve_approval(req.id, {"behavior": "deny", "message": "Server shutting down"})
            session.pending_approvals = []
            # Tag this close as "shutdown" so the cloud can tell it apart from a user-initiated close. The desktop doesn't care; the tag rides along in the dump for whoever consumes it.
            self.sync_session_close(session, close_reason="shutdown")
            doc_data = session.model_dump(mode="json")
            doc_data["search_text"] = self.build_search_text(session)
            save_session(session_id, doc_data)
            logger.info(f"Persisted session {session_id} on shutdown")
        self.sessions.clear()
        self.tasks.clear()

    @typechecked
    async def restore_all_sessions(self) -> None:
        """On startup, reload all persisted sessions from JSON files back into memory.

        Only sessions without closed_at are restored (they were active at
        shutdown).  Sessions with closed_at were explicitly closed by the user
        and stay on disk so the history endpoint can still serve them.
        """
        for sid, data in load_all_session_data():
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
            delete_session_file(sid)
            logger.info(f"Restored session {session.id}")
