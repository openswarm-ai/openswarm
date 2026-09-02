"""Bulk session persistence across the WHOLE store, the startup/shutdown orchestration that
operates on every session at once (reconcile stale-running, flush-all on shutdown, restore-all
on boot). Split from SessionLifecycle (which handles ONE session at a time) so each file is
one concern. self.sessions resolves across the MRO as before."""

import logging
import os
import sys
from typing import Optional

from typeguard import typechecked

from backend.apps.agents.core.models import AgentSession, Message
from backend.apps.agents.core.ws_manager import ws_manager
from backend.apps.agents.manager.session.session_store import (
    load_all_session_data,
    save_session,
)
from backend.apps.agents.manager.session.apply_context_window import apply_context_window

logger = logging.getLogger(__name__)


def auto_resume_held_because() -> Optional[str]:
    """Why auto-resume must not fire this boot, in words, or None to proceed.

    Auto-resume dispatches REAL turns: live credentials, live Bash, in whatever tree the process
    was started from. Two callers need it held. A test that boots the app lifespan must never do
    that to the developer's own chats. And the desktop app holds it after repeated dirty exits,
    because resuming straight back into the turn that was running when the app died is how a single
    crash became four (ENG-400); the amber Resume chip is still there, so the user decides.

    The env var is the DECLARED signal and both set it. `pytest in sys.modules` is kept only as a
    belt-and-braces fallback, and deliberately not as the primary: an incidental signal fails in the
    worst direction, because the day pytest becomes importable in a packaged build every
    crash-interrupted turn stops resuming and NOTHING says so. Work vanishing quietly is the worst
    bug this codebase can ship; a boot that loudly refuses to resume is merely annoying."""
    if os.environ.get("OSW_DISABLE_AUTO_RESUME") == "1":
        return "the app asked for it (test run, or safe mode after repeated crashes)"
    if "pytest" in sys.modules:
        return "pytest is loaded"
    return None


def running_under_test() -> bool:
    return auto_resume_held_because() is not None


from backend.apps.agents.manager.AgentManagerProtocol import AgentManagerProtocol


SHUTDOWN_STOP_NOTE = (
    "This chat was still running when OpenSwarm's engine shut down, so it stopped here; that was not "
    "your Stop. Send a message to continue from where it left off."
)


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
                p_tail_role = p_msgs[-1].get("role") if p_msgs else None
                # A system-role tail is a card (overflow, exhausted, a notice): terminal unless a continuation was armed behind it, so a finished chat is never poked back to life (ENG-366).
                p_owed = bool(p_msgs) and p_tail_role != "assistant" and (p_tail_role != "system" or bool(data.get("pending_continuation")))
                if p_was_running and p_owed and data.get("closed_at") is None:
                    count = int(data.get("crash_interrupt_count", 0) or 0) + 1
                    data["crash_interrupt_count"] = count
                    if count <= 1:
                        self.crash_resume_queue.append(sid)
                    else:
                        logger.warning(f"crash-resume breaker: session {sid} was mid-turn at {count} consecutive dirty deaths; leaving it for the manual chip")
            elif data.get("awaiting_reconnect") and data.get("closed_at") is None:
                # Parked mid-outage when the app went down. The file says "completed" only because
                # the wait was dispatched as a continuation, so the status check above cannot see
                # it; without this the task the user never chose to end just evaporates.
                data["awaiting_reconnect"] = False
                dirty = True
                count = int(data.get("crash_interrupt_count", 0) or 0) + 1
                data["crash_interrupt_count"] = count
                if count <= 1:
                    self.crash_resume_queue.append(sid)
                else:
                    logger.warning(f"crash-resume breaker: session {sid} was parked mid-outage at {count} consecutive dirty deaths; leaving it for the manual chip")

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
        p_held = auto_resume_held_because()
        if p_held:
            logger.info(f"crash-resume: {len(self.crash_resume_queue or [])} turn(s) NOT auto-resumed because {p_held}; each keeps its Resume chip")
            self.crash_resume_queue = []
            return
        for sid in list(getattr(self, "crash_resume_queue", []) or []):
            try:
                # send_message lives on the Messaging mixin; AgentManager composes both.
                p_send = getattr(self, "send_message")
                await p_send(
                    sid,
                    "The app restarted while you were mid-task; nothing was lost. Continue exactly "
                    "where you left off; do not redo completed steps.",
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
                # Say who stopped it. A chat flushed as plain "stopped" reads exactly like the user's own
                # Stop, and when something else killed the backend (an agent's pkill, 2026-09-01) the
                # user's running work vanished with nothing saying why: silent loss, row 1.
                session.messages.append(Message(role="system", content=SHUTDOWN_STOP_NOTE, branch_id=session.active_branch_id))
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
