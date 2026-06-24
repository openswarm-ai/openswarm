"""Submit a session snapshot to the cloud on close. The cloud consumes the dump however it sees
fit; the desktop just hands off a snapshot. Skipped for mock sessions so dev runs don't post to
the real backend. Synthesizes a closed_at timestamp on the cloud-bound dump if the session lacks
one (two paths, browser_agent close and shutdown_all_sessions, previously sent it null, which
left the cloud unable to compute duration_ms). Fixed here at the bottleneck so no call site can
miss it; the on-disk session JSON keeps its original (possibly None) closed_at."""

from datetime import datetime

from typeguard import typechecked

from backend.apps.agents.core.models import AgentSession
from backend.apps.service.client import sync as submit_to_cloud


@typechecked
def sync_session_close(session: AgentSession, close_reason: str = "user") -> None:
    if close_reason == "mock" or getattr(session, "_mock_run", False):
        return
    try:
        dump = session.model_dump(mode="json")
        if not dump.get("closed_at"):
            dump["closed_at"] = datetime.now().isoformat()
        submit_to_cloud(dump)
    except Exception:
        pass
