"""Run a workflow by launching an agent session and feeding it the steps.

The executor is intentionally thin: it leans entirely on agent_manager's
existing launch + send_message path so a scheduled run looks identical to
a manual chat. That keeps the MCP gate, action filtering, provider
routing, retries, and history all aligned with the rest of the app.
"""

import asyncio
import logging
from datetime import datetime
from typing import Optional

from backend.apps.agents.models import AgentConfig
from backend.apps.workflows.models import Workflow, WorkflowRun
from backend.apps.workflows import storage

logger = logging.getLogger(__name__)


# In-process map: workflow_id -> currently running run id. Prevents two
# overlapping fires for the same workflow (e.g. cron tick races a manual
# Run button) without serializing across the whole executor.
_running: dict[str, str] = {}
_running_lock = asyncio.Lock()


def _resolve_system_prompt(wf: Workflow) -> Optional[str]:
    if wf.use_synced_prompt:
        return None
    return wf.system_prompt or None


def _resolve_allowed_tools(wf: Workflow) -> list[str]:
    if not wf.actions.freeze:
        return []
    return list(wf.actions.configured_sets)


async def execute(wf: Workflow, triggered_by: str = "schedule", scheduled_for: Optional[datetime] = None) -> WorkflowRun:
    from backend.apps.agents.agent_manager import agent_manager

    run = WorkflowRun(
        workflow_id=wf.id,
        status="running",
        scheduled_for=scheduled_for,
        started_at=datetime.now(),
        triggered_by=triggered_by,
    )
    storage.record_run(run)

    async with _running_lock:
        if wf.id in _running:
            run.status = "skipped"
            run.error = "Previous run still active"
            run.finished_at = datetime.now()
            storage.record_run(run)
            return run
        _running[wf.id] = run.id

    wf.last_run_at = run.started_at
    wf.last_run_status = "running"
    wf.last_run_id = run.id
    storage.save_workflow(wf)

    try:
        steps = [s.text for s in wf.steps if s.text and s.text.strip()]
        if not steps:
            raise ValueError("Workflow has no steps")

        config = AgentConfig(
            name=wf.title or "Workflow",
            model=wf.model or "sonnet",
            mode=wf.mode or "agent",
            provider=wf.provider or "anthropic",
            system_prompt=_resolve_system_prompt(wf),
            allowed_tools=_resolve_allowed_tools(wf) or [
                "Read", "Edit", "Write", "Bash", "Glob", "Grep", "AskUserQuestion",
            ],
            dashboard_id=wf.dashboard_id,
        )

        session = await agent_manager.launch_agent(config)
        run.session_id = session.id
        storage.record_run(run)

        # Send each step sequentially. agent_manager.send_message is a no-op
        # while a prior turn is still streaming, so we await until the
        # session is idle before posting the next step. Keeps the runner
        # safe regardless of how long each turn takes.
        step_error: Optional[str] = None
        for step in steps:
            await agent_manager.send_message(session.id, step)
            await _await_session_idle(session.id)
            sess_state = agent_manager.sessions.get(session.id)
            if sess_state is not None and getattr(sess_state, "status", None) == "error":
                step_error = "Agent session entered error state"
                break

        run.finished_at = datetime.now()
        sess_state = agent_manager.sessions.get(session.id)
        if sess_state is not None:
            run.cost_usd = float(getattr(sess_state, "cost_usd", 0.0) or 0.0)

        if step_error is not None:
            run.status = "failure"
            run.error = step_error
            wf.last_run_status = "failure"
        elif scheduled_for is not None and (run.finished_at - scheduled_for).total_seconds() > 300:
            # Started more than 5 minutes after its slot (app was closed,
            # event loop backed up, etc.). Surface in History as ran_late
            # so the user can tell apart "fired on time" from "caught up".
            run.status = "ran_late"
            wf.last_run_status = "ran_late"
        else:
            run.status = "success"
            wf.last_run_status = "success"
        storage.record_run(run)
        wf.last_run_at = run.finished_at
        storage.save_workflow(wf)
    except Exception as e:
        logger.exception("Workflow run failed: %s", e)
        run.status = "failure"
        run.error = str(e)[:500]
        run.finished_at = datetime.now()
        storage.record_run(run)
        wf.last_run_status = "failure"
        storage.save_workflow(wf)
    finally:
        async with _running_lock:
            _running.pop(wf.id, None)

    try:
        from backend.apps.workflows.notifier import notify_run_complete
        await notify_run_complete(wf, run)
    except Exception:
        logger.debug("notifier failed", exc_info=True)

    try:
        from backend.apps.agents.ws_manager import ws_manager
        await ws_manager.broadcast_global("workflow:run", {
            "workflow_id": wf.id,
            "run": run.model_dump(mode="json"),
        })
    except Exception:
        pass

    return run


async def _await_session_idle(session_id: str, timeout_s: float = 600.0) -> None:
    """Block until the agent session reaches a non-running terminal state.

    Polls cheaply (50ms) since the agent_manager doesn't expose a per-session
    completion future. Bounded by timeout_s so a stuck step doesn't hang the
    runner forever.
    """
    from backend.apps.agents.agent_manager import agent_manager

    deadline = asyncio.get_event_loop().time() + timeout_s
    while True:
        sess = agent_manager.sessions.get(session_id)
        if not sess:
            return
        task = agent_manager.tasks.get(session_id)
        if task is not None and task.done():
            return
        status = getattr(sess, "status", None)
        if status in ("completed", "error", "stopped"):
            return
        if asyncio.get_event_loop().time() > deadline:
            raise TimeoutError(f"Step exceeded {timeout_s}s on session {session_id}")
        await asyncio.sleep(0.05)
