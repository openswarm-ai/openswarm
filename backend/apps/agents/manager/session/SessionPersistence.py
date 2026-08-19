"""Bulk session persistence across the WHOLE store, the startup/shutdown orchestration that
operates on every session at once (reconcile stale-running, flush-all on shutdown, restore-all
on boot). Split from SessionLifecycle (which handles ONE session at a time) so each file is
one concern. self.sessions resolves across the MRO as before."""

import logging

from typeguard import typechecked

from backend.apps.agents.core.models import AgentSession
from backend.apps.agents.core.ws_manager import ws_manager
from backend.apps.agents.manager.session.session_store import (
    load_all_session_data,
    save_session,
)
from backend.apps.agents.manager.session.apply_context_window import apply_context_window

logger = logging.getLogger(__name__)


from backend.apps.agents.manager.AgentManagerProtocol import AgentManagerProtocol


class SessionPersistence(AgentManagerProtocol):
    @typechecked
    async def reconcile_on_startup(self) -> None:
        """Mark any stale running sessions as stopped, and queue crash-interrupted turns for
        auto-resume. A file still saying "running" at boot is PROOF of a dirty death (a graceful
        quit flushes "stopped"), so the user's task was cut off through no choice of their own;
        those resume themselves. The breaker (hermes #30719): a session mid-turn at TWO
        consecutive dirty deaths is plausibly what keeps killing the process, so it gets the
        amber chip instead of a third run. A user's own Cmd+Q never lands here."""
        marked = 0
        self.crash_resume_queue = []
        for sid, data in load_all_session_data():
            dirty = False
            if data.get("status") in ("running", "waiting_approval"):
                p_was_running = data.get("status") == "running"
                data["status"] = "stopped"
                dirty = True
                marked += 1
                branch = data.get("active_branch_id") or "main"
                p_msgs = [m for m in data.get("messages", []) if (m.get("branch_id") or "main") == branch]
                p_owed = bool(p_msgs) and p_msgs[-1].get("role") != "assistant"
                if p_was_running and p_owed and data.get("closed_at") is None:
                    count = int(data.get("crash_interrupt_count", 0) or 0) + 1
                    data["crash_interrupt_count"] = count
                    if count <= 1:
                        self.crash_resume_queue.append(sid)
                    else:
                        logger.warning(f"crash-resume breaker: session {sid} was mid-turn at {count} consecutive dirty deaths; leaving it for the manual chip")
            # Mode migration: Chat was merged into Ask. Rewrite mode="chat" so old sessions keep loading after the chat.json file is gone.
            if data.get("mode") == "chat":
                data["mode"] = "ask"
                dirty = True
            if dirty:
                save_session(sid, data)
        if marked:
            logger.info(f"Marked {marked} stale session(s) as stopped")
        if self.crash_resume_queue:
            logger.info(f"crash-resume: {len(self.crash_resume_queue)} turn(s) cut off by the dirty exit will auto-resume")

    @typechecked
    async def auto_resume_crashed_turns(self) -> None:
        """Fire one hidden continuation into each crash-interrupted session (called after
        restore, off the boot critical path). Failure is per-session and non-fatal: a session
        that cannot resume just keeps its amber chip."""
        for sid in list(getattr(self, "crash_resume_queue", []) or []):
            try:
                await self.send_message(
                    sid,
                    "[Automated message from OpenSwarm itself, not written by your user] The app "
                    "restarted while you were mid-task; nothing was lost. Continue exactly where "
                    "you left off; do not redo completed steps.",
                    hidden=True,
                )
                logger.info(f"crash-resume: session {sid} auto-resumed")
            except Exception:
                logger.warning(f"crash-resume: session {sid} failed to auto-resume; amber chip remains", exc_info=True)
        self.crash_resume_queue = []

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
            doc_data = session.model_dump(mode="json")
            doc_data["search_text"] = self.build_search_text(session)
            save_session(session_id, doc_data)
        if self.sessions:
            logger.info(f"Persisted {len(self.sessions)} session(s) on shutdown")
        self.sessions.clear()
        self.tasks.clear()

    @typechecked
    async def restore_all_sessions(self) -> None:
        """On startup, reload all persisted sessions from JSON files back into memory.

        Only sessions without closed_at are restored (they were active at
        shutdown).  Sessions with closed_at were explicitly closed by the user
        and stay on disk so the history endpoint can still serve them.
        """
        restored = 0
        deferred = 0
        for sid, data in load_all_session_data():
            if not isinstance(data, dict):
                continue
            # Only mid-turn sessions need boot hydration (their status finalize below). Everything
            # else loads on demand: history reads disk, dashboard lists promote by layout card ids,
            # and resume/send_message both lazy-load. Eagerly validating thousands of settled
            # sessions was the 2.7s (and hundreds of MB) of every boot.
            if data.get("closed_at") is not None:
                continue
            if data.get("status") not in ("running", "waiting_approval"):
                deferred += 1
                continue
            try:
                session = AgentSession(**data)
            except Exception as e:
                logger.warning(f"Skipping corrupt session file {sid}: {e}")
                continue
            if session.status in ("running", "waiting_approval"):
                # The app died mid-turn. If the last message in the active branch is already an assistant reply, the turn finished streaming and only the status finalize was lost (-> completed, no spurious "Resume" button); otherwise the agent was genuinely cut off owing a response (-> stopped, resumable).
                branch = session.active_branch_id or "main"
                p_branch_msgs = [m for m in session.messages if (m.branch_id or "main") == branch]
                p_last = p_branch_msgs[-1] if p_branch_msgs else None
                session.status = "completed" if (p_last is not None and p_last.role == "assistant") else "stopped"
            session.pending_approvals = []
            apply_context_window(session)
            # The file stays on disk: unlinking here made RAM the only copy, so any non-graceful shutdown (updater SIGKILL, crash) destroyed the chat.
            self.sessions[session.id] = session
            restored += 1
        # One summary line, not one per session (startups with hundreds of sessions flooded the console).
        if restored or deferred:
            logger.info(f"Restored {restored} mid-turn session(s); {deferred} settled session(s) stay on disk for lazy load")
