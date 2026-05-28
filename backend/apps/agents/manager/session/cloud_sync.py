from datetime import datetime

from backend.apps.agents.core.models import AgentSession
from backend.apps.service.client import sync as _sync


def _sync_session_close(session: AgentSession, close_reason: str = "user"):
    """Submit the session state to the cloud on close. The cloud
    consumes the dump however it sees fit; the desktop just hands off
    a snapshot. Skipped for mock sessions so dev runs don't post to
    the real backend.

    Synthesizes a `closed_at` timestamp on the dump if the session
    doesn't have one. Two paths previously sent close-events without
    a timestamp and made the cloud unable to compute duration_ms
    (which surfaced as duration_ms=null on 90% of session.ended events,
    browser-agent and shutdown paths in particular):

      1. browser_agent.py calls this without setting closed_at.
      2. shutdown_all_sessions() clears closed_at to None for the
         on-disk restore mechanism, then syncs.

    Fix is here at the bottleneck rather than at every caller so we
    can't miss a future call site. The on-disk session JSON keeps its
    original (possibly None) closed_at, only the cloud-bound dump
    gets the synthesized timestamp.
    """
    if close_reason == "mock" or getattr(session, "_mock_run", False):
        return
    try:
        dump = session.model_dump(mode="json")
        if not dump.get("closed_at"):
            dump["closed_at"] = datetime.now().isoformat()
        _sync(dump)
    except Exception:
        pass
