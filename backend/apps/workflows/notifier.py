"""Permission/escalation chain notifier.

The notify tier broadcasts a ws event the renderer picks up. The text/call
tiers route through the cloud SMS bridge once enabled; until it's enabled
we fall back to an extra ws notify with a `fallback: true` marker so the
renderer can label it honestly ("Text-me fallback: cloud SMS not wired").
The *when* of escalation is owned by apps/workflows/escalation.py.
"""

import logging
from datetime import datetime

from backend.apps.workflows.models import PermissionTier, Workflow, WorkflowRun

logger = logging.getLogger(__name__)


def _base_payload(wf: Workflow, run: WorkflowRun) -> dict:
    return {
        "workflow_id": wf.id,
        "workflow_title": wf.title,
        "run_id": run.id,
        "status": run.status,
        "session_id": run.session_id,
        "started_at": run.started_at.isoformat() if isinstance(run.started_at, datetime) else run.started_at,
        "finished_at": run.finished_at.isoformat() if isinstance(run.finished_at, datetime) else run.finished_at,
    }


async def notify_run_complete(wf: Workflow, run: WorkflowRun) -> None:
    from backend.apps.agents.core.ws_manager import ws_manager
    from backend.apps.workflows import escalation

    payload = _base_payload(wf, run)
    await ws_manager.broadcast_global("workflow:notify", payload)

    # Kick off server-side escalation only if there are additional tiers
    # beyond the default notify. The escalation runner will sleep + call
    # send_tier per tier.
    escalation.schedule(wf, run)


async def send_tier(wf: Workflow, run: WorkflowRun, tier: PermissionTier) -> None:
    """Send a single escalation tier. Today the text/call paths fall back
    to an in-app notify with `fallback: true` and the tier kind set so the
    renderer can show "Text-me fallback (cloud SMS not wired)."
    """
    from backend.apps.agents.core.ws_manager import ws_manager

    payload = _base_payload(wf, run)
    payload["tier_kind"] = tier.kind
    payload["tier_phone"] = (tier.phone or "")[-4:] if tier.phone else None
    payload["fallback"] = True  # flip to False once the cloud SMS bridge is wired
    await ws_manager.broadcast_global("workflow:notify", payload)
    logger.info("workflow tier=%s fallback fired wf=%s run=%s", tier.kind, wf.id, run.id)
