"""Permission/escalation chain notifier.

Today we only emit the in-app notify tier (via ws broadcast). The text/call
tiers are wired into the schema and exposed in the UI so the permission
chain is editable today; the actual SMS/voice integration ships with the
cloud-side affiliate billing infra and is intentionally stubbed here.
"""

import asyncio
import logging
from datetime import datetime

from backend.apps.workflows.models import Workflow, WorkflowRun

logger = logging.getLogger(__name__)


async def notify_run_complete(wf: Workflow, run: WorkflowRun) -> None:
    from backend.apps.agents.ws_manager import ws_manager

    primary = (wf.permissions or [None])[0]
    kind = getattr(primary, "kind", "notify") if primary else "notify"

    payload = {
        "workflow_id": wf.id,
        "workflow_title": wf.title,
        "run_id": run.id,
        "status": run.status,
        "session_id": run.session_id,
        "started_at": run.started_at.isoformat() if isinstance(run.started_at, datetime) else run.started_at,
        "finished_at": run.finished_at.isoformat() if isinstance(run.finished_at, datetime) else run.finished_at,
    }

    if kind == "notify":
        await ws_manager.broadcast_global("workflow:notify", payload)
        return

    # text/call tiers stubbed; emit the same notify event so the UI still
    # surfaces completion. Escalation timing is enforced client-side until
    # the cloud-side bridge ships.
    await ws_manager.broadcast_global("workflow:notify", payload)
    logger.info("workflow:notify (escalation tier=%s stubbed): %s", kind, wf.id)
    await asyncio.sleep(0)
