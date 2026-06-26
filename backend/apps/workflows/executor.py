"""Run a workflow by launching an agent session and feeding it the steps.

The executor is intentionally thin: it leans entirely on agent_manager's
existing launch + send_message path so a scheduled run looks identical to
a manual chat. That keeps the MCP gate, action filtering, provider
routing, retries, and history all aligned with the rest of the app.
"""

import asyncio
import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

from backend.apps.agents.core.models import AgentConfig
from backend.apps.workflows.models import Workflow, WorkflowRun
from backend.apps.workflows import storage

logger = logging.getLogger(__name__)


# In-process map: workflow_id -> currently running run id. Prevents two overlapping fires for the same workflow (e.g. cron tick races a manual Run button) without serializing across the whole executor.
_running: dict[str, str] = {}
_running_lock = asyncio.Lock()


def p_ran_late(started_at: datetime, scheduled_for: datetime) -> bool:
    """Late means the run STARTED well after its slot (app was closed, event
    loop backed up), not that it ran long. Measured from started_at so a
    punctual run that simply takes a while isn't mislabeled. Both sides
    normalized to UTC; a naive started_at is host-local."""
    delta = started_at.astimezone(timezone.utc) - scheduled_for.astimezone(timezone.utc)
    return delta.total_seconds() > 300


# run_id -> "stop". Set by the stop endpoint so the executor loop, not the HTTP handler, owns the run's terminal write. Without this the still-running executor task could overwrite a "Stopped by user" failure with success. Pause is NOT in here: it rides the agent session's own "stopped" status, which the step loop waits out (see _await_session_idle).
_run_control: dict[str, str] = {}
_run_pause_override: dict[str, tuple[bool, float]] = {}


def request_stop(run_id: str) -> None:
    _run_control[run_id] = "stop"


def set_pause_override(run_id: str, paused: bool, ttl_s: float = 5.0) -> None:
    """Keep an explicit pause/resume control state authoritative briefly.

    The tool watcher normally derives paused from the agent session status,
    but pause/resume endpoints now return before the slower agent_manager call
    finishes. This prevents the watcher from broadcasting the pre-control
    status during that handoff window.
    """
    _run_pause_override[run_id] = (paused, asyncio.get_event_loop().time() + ttl_s)


def _resolve_system_prompt(wf: Workflow) -> Optional[str]:
    if wf.use_synced_prompt:
        return None
    return wf.system_prompt or None


def _resolve_allowed_tools(wf: Workflow) -> Optional[list[str]]:
    if not wf.actions.freeze:
        return None
    return list(wf.actions.configured_sets)


def p_resolve_run_dashboard_id(wf: Workflow) -> Optional[str]:
    """Pick the dashboard this run's agent attaches to, so browser tools work like in chat.

    Browser cards render only on the dashboard the renderer is currently showing, so we
    prefer the live active dashboard over anything stored. Resolved fresh each fire (a
    stored id goes stale the moment the user switches or deletes a dashboard). Last resort
    is the most-recently-updated dashboard; None just means no browser this run."""
    if wf.dashboard_id:
        return wf.dashboard_id
    from backend.apps.agents.core.ws_manager import ws_manager
    if ws_manager.active_dashboard_id:
        return ws_manager.active_dashboard_id
    from backend.apps.dashboards.dashboards import load_all
    dashboards = load_all()
    if dashboards:
        dashboards.sort(key=lambda d: d.updated_at or d.created_at, reverse=True)
        return dashboards[0].id
    return None


def p_make_remember_approval(workflow_id: str):
    def p_remember_approval(tool_name: str, behavior: str) -> None:
        fresh = storage.get_workflow(workflow_id)
        if fresh is None:
            return
        fresh.remembered_approvals = {**fresh.remembered_approvals, tool_name: behavior}
        storage.save_workflow(fresh)
        try:
            from backend.apps.agents.core.ws_manager import ws_manager
            asyncio.get_running_loop().create_task(ws_manager.broadcast_global("workflow:updated", {
                "workflow_id": fresh.id,
                "workflow": fresh.model_dump(mode="json"),
            }))
        except Exception:
            pass
    return p_remember_approval


def p_persist_step_tool_usage(
    workflow_id: str,
    step_usage: dict[str, dict[str, bool]],
    tested_signature: Optional[str] = None,
) -> None:
    fresh = storage.get_workflow(workflow_id)
    if fresh is None:
        return
    live_ids = {s.id for s in fresh.steps}
    draft = getattr(fresh, "draft_steps", None)
    if draft is not None:
        live_ids.update(s.id for s in draft)
    fresh.step_tool_usage = {
        sid: dict(tools)
        for sid, tools in (step_usage or {}).items()
        if sid in live_ids and isinstance(tools, dict)
    }
    if tested_signature is not None:
        fresh.tested_signature = tested_signature
    storage.save_workflow(fresh)
    try:
        from backend.apps.agents.core.ws_manager import ws_manager
        asyncio.get_running_loop().create_task(ws_manager.broadcast_global("workflow:updated", {
            "workflow_id": fresh.id,
            "workflow": fresh.model_dump(mode="json"),
        }))
    except Exception:
        pass


def _persist_run_fields(wf: Workflow, run_fields: dict, schedule_runs_count_delta: int = 0) -> None:
    """Merge run-side fields into the current on-disk workflow.

    The executor holds the `wf` it was launched with; meanwhile the user
    may have PATCHed unrelated fields (title, schedule, permissions...).
    Saving our captured `wf` would clobber those edits. Re-read the
    authoritative record from storage and only mutate the run-side fields
    we own. If the workflow has been deleted while we ran, silently skip
    the save so we don't resurrect a deleted record.

    schedule_runs_count_delta is a small int (0 or 1) that we add to the
    on-disk schedule.runs_count to avoid the same race overwriting an
    in-flight bump on the user's PATCH path.
    """
    fresh = storage.get_workflow(wf.id)
    if fresh is None:
        # Deleted while we ran. Don't resurrect.
        return
    for k, v in run_fields.items():
        setattr(fresh, k, v)
    if schedule_runs_count_delta:
        fresh.schedule.runs_count = fresh.schedule.runs_count + schedule_runs_count_delta
    storage.save_workflow(fresh)


def _monthly_spend_so_far(wf: Workflow) -> float:
    """Sum cost_usd across runs of `wf` started in the last 30 days.

    Reads the bounded run log (200 rows max per workflow), so this is
    O(history) and runs once per fire. Naive datetimes (legacy rows) are
    treated as host-local then normalized to UTC by Python's astimezone.
    """
    cutoff = datetime.now(timezone.utc) - timedelta(days=30)
    total = 0.0
    for r in storage.list_runs(wf.id, limit=200):
        started = r.started_at
        if started is None:
            continue
        if started.tzinfo is None:
            started = started.astimezone(timezone.utc)
        else:
            started = started.astimezone(timezone.utc)
        if started >= cutoff:
            total += float(r.cost_usd or 0.0)
    return total


async def execute(
    wf: Workflow,
    triggered_by: str = "schedule",
    scheduled_for: Optional[datetime] = None,
    tested_signature: Optional[str] = None,
) -> WorkflowRun:
    from backend.apps.agents.agent_manager import agent_manager
    from backend.apps.agents.manager.permissions.workflow_approval import (
        clear_workflow_approval_memory,
        get_workflow_step_usage,
        set_workflow_approval_memory,
        set_workflow_approval_step,
    )

    run = WorkflowRun(
        workflow_id=wf.id,
        status="running",
        scheduled_for=scheduled_for,
        started_at=datetime.now(),
        triggered_by=triggered_by,
    )

    # Cost cap pre-check happens before claiming `_running` so a capped workflow doesn't block its own next fire. We still record the run so the user sees it in History with a clear reason.
    if wf.cost_cap_usd_monthly is not None:
        spent = _monthly_spend_so_far(wf)
        if spent >= wf.cost_cap_usd_monthly:
            run.status = "skipped"
            run.error = f"Monthly cost cap reached (${spent:.2f} / ${wf.cost_cap_usd_monthly:.2f})"
            run.finished_at = datetime.now()
            storage.record_run(run)
            _persist_run_fields(wf, {
                "last_run_at": run.finished_at,
                "last_run_status": "skipped",
                "last_run_id": run.id,
            })
            return run

    storage.record_run(run)

    async with _running_lock:
        if wf.id in _running:
            run.status = "skipped"
            run.error = "Previous run still active"
            run.finished_at = datetime.now()
            storage.record_run(run)
            return run
        _running[wf.id] = run.id

    session = None
    try:
        wf.last_run_at = run.started_at
        wf.last_run_status = "running"
        wf.last_run_id = run.id
        _persist_run_fields(wf, {
            "last_run_at": run.started_at,
            "last_run_status": "running",
            "last_run_id": run.id,
        })

        # Announce the run as running the instant it claims execution, not at the first step. Without this a run that fails fast (e.g. no runnable steps) or hasn't streamed yet never hits the Home "Ongoing runs" list. Both this and the persist above sit inside the try whose finally frees _running, so a persist/broadcast failure can't strand the workflow as permanently "running" (which would block every future fire).
        try:
            from backend.apps.agents.core.ws_manager import ws_manager as _wsm_start
            await _wsm_start.broadcast_global("workflow:run", {
                "workflow_id": wf.id,
                "run": run.model_dump(mode="json"),
            })
        except Exception:
            pass

        steps = [s for s in wf.steps if s.enabled and s.text and s.text.strip()]
        if not steps:
            raise ValueError("Workflow has no steps")

        resolved_allowed_tools = _resolve_allowed_tools(wf)
        config = AgentConfig(
            name=wf.title or "Workflow",
            model=wf.model or "sonnet",
            mode=wf.mode or "agent",
            provider=wf.provider or "anthropic",
            system_prompt=_resolve_system_prompt(wf),
            allowed_tools=resolved_allowed_tools if resolved_allowed_tools is not None else [
                "Read", "Edit", "Write", "Bash", "Glob", "Grep", "AskUserQuestion",
            ],
            dashboard_id=p_resolve_run_dashboard_id(wf),
        )

        session = await agent_manager.launch_agent(config)
        run.session_id = session.id
        storage.record_run(run)

        # Reuse the user's earlier allow/deny answers so an unattended fire doesn't park on a permission prompt. Scheduled runs prompt for an unseen tool only briefly (30s) before failing; manual/test runs are attended, so keep the roomy window. Sensitive-path prompts are never remembered (handled by the gate); they keep prompting every run.
        set_workflow_approval_memory(
            session.id,
            decisions=dict(wf.remembered_approvals),
            step_usage={sid: dict(tools) for sid, tools in wf.step_tool_usage.items()},
            remember=p_make_remember_approval(wf.id),
            ask_timeout=30.0 if triggered_by == "schedule" else 600.0,
        )

        # Background poller: surface the latest tool-call name as a live "what's the agent doing" subtitle on the workflow:run ws event. Cheap enough to run at 1.5s cadence; nothing else is watching session.messages from here. Cancelled in the finally block alongside _running cleanup.
        async def _watch_tool_calls() -> None:
            last_seen = ""
            last_paused = False
            while True:
                try:
                    await asyncio.sleep(1.5)
                    sess = agent_manager.sessions.get(session.id)
                    if not sess:
                        return
                    now = asyncio.get_event_loop().time()
                    override = _run_pause_override.get(run.id)
                    if override and override[1] >= now:
                        paused_now = override[0]
                    else:
                        if override:
                            _run_pause_override.pop(run.id, None)
                        paused_now = getattr(sess, "status", None) == "stopped"
                    msgs = getattr(sess, "messages", []) or []
                    label = ""
                    for m in reversed(msgs):
                        if getattr(m, "role", None) != "tool_call":
                            continue
                        content = getattr(m, "content", None)
                        # Content can be a string, a dict with "name", or a list of blocks. Pick the first tool_use name.
                        if isinstance(content, list):
                            for b in content:
                                if isinstance(b, dict) and b.get("type") == "tool_use":
                                    label = str(b.get("name") or "")
                                    break
                        elif isinstance(content, dict):
                            label = str(content.get("name") or "")
                        elif isinstance(content, str):
                            label = content[:60]
                        if label:
                            break
                    label_changed = bool(label) and label != last_seen
                    if label_changed or paused_now != last_paused:
                        if label_changed:
                            last_seen = label
                            run.last_tool_label = label
                        last_paused = paused_now
                        run.paused = paused_now
                        try:
                            from backend.apps.agents.core.ws_manager import ws_manager
                            await ws_manager.broadcast_global("workflow:run", {
                                "workflow_id": wf.id,
                                "run": run.model_dump(mode="json"),
                            })
                        except Exception:
                            pass
                except asyncio.CancelledError:
                    return
                except Exception:
                    return

        watcher_task = asyncio.create_task(_watch_tool_calls())

        # Send each step sequentially. agent_manager.send_message is a no-op while a prior turn is still streaming, so we await until the session is idle before posting the next step. Keeps the runner safe regardless of how long each turn takes.
        step_error: Optional[str] = None
        for idx, step in enumerate(steps):
            if _run_control.get(run.id) == "stop":
                step_error = "Stopped by user"
                break
            # Broadcast the step bump before sending so RunningView flips the disc immediately, not after the agent finishes the step. Advancing means we're not paused; keep the broadcast authoritative so it never races a stale paused=True from the watcher.
            run.active_step_idx = idx
            run.last_tool_label = None
            run.paused = False
            set_workflow_approval_step(session.id, step.id)
            try:
                from backend.apps.agents.core.ws_manager import ws_manager as _wsm
                await _wsm.broadcast_global("workflow:run", {
                    "workflow_id": wf.id,
                    "run": run.model_dump(mode="json"),
                })
            except Exception:
                pass
            await agent_manager.send_message(session.id, step.text)
            disp = await _await_session_idle(session.id, run.id)
            if disp == "stopped":
                step_error = "Stopped by user"
                # Pin active step so FailedView renders the X on the right row.
                break
            if disp == "error":
                step_error = "Agent session entered error state"
                break

        run.finished_at = datetime.now()
        run.paused = False
        sess_state = agent_manager.sessions.get(session.id)
        if sess_state is not None:
            run.cost_usd = float(getattr(sess_state, "cost_usd", 0.0) or 0.0)

        if step_error is not None:
            run.status = "failure"
            run.error = step_error
            wf.last_run_status = "failure"
        elif scheduled_for is not None and p_ran_late(run.started_at, scheduled_for):
            run.status = "ran_late"
            wf.last_run_status = "ran_late"
        else:
            run.status = "success"
            wf.last_run_status = "success"
        # Bump runs_count for scheduled fires that reached a terminal state other than "skipped". Manual runs don't count against max_runs.
        runs_delta = 1 if (triggered_by == "schedule" and run.status in ("success", "ran_late", "failure")) else 0
        storage.record_run(run)
        wf.last_run_at = run.finished_at
        run_fields = {
            "last_run_at": run.finished_at,
            "last_run_status": wf.last_run_status,
        }
        if triggered_by == "manual" and run.status in ("success", "ran_late") and isinstance(tested_signature, str):
            run_fields["tested_signature"] = tested_signature
        _persist_run_fields(wf, run_fields, schedule_runs_count_delta=runs_delta)
    except Exception as e:
        logger.exception("Workflow run failed: %s", e)
        run.status = "failure"
        run.error = str(e)[:500]
        run.finished_at = datetime.now()
        run.paused = False
        storage.record_run(run)
        wf.last_run_status = "failure"
        _persist_run_fields(wf, {
            "last_run_status": "failure",
            "last_run_at": run.finished_at,
        })
    finally:
        _run_control.pop(run.id, None)
        _run_pause_override.pop(run.id, None)
        # Cancel the tool-call watcher before we tear the session down so the next poll doesn't race close_session.
        try:
            watcher_task.cancel()  # type: ignore[name-defined]
        except Exception:
            pass
        # Close the workflow's agent session so closed_at is set and the run shows up in chat history (get_history sorts by closed_at; sessions with closed_at=None sort to the bottom and fall off the first page). close_session also drops in-memory state and persists the final snapshot to disk.
        if session is not None:
            try:
                p_persist_step_tool_usage(wf.id, get_workflow_step_usage(session.id))
            except Exception:
                logger.exception("persist step tool usage failed for workflow %s", wf.id)
            set_workflow_approval_step(session.id, None)
            clear_workflow_approval_memory(session.id)
            try:
                await agent_manager.close_session(session.id)
            except Exception:
                logger.exception("close_session failed for workflow run %s", run.id)
        async with _running_lock:
            _running.pop(wf.id, None)

    try:
        from backend.apps.workflows.notifier import notify_run_complete
        await notify_run_complete(wf, run)
    except Exception:
        logger.debug("notifier failed", exc_info=True)

    try:
        from backend.apps.agents.core.ws_manager import ws_manager
        await ws_manager.broadcast_global("workflow:run", {
            "workflow_id": wf.id,
            "run": run.model_dump(mode="json"),
        })
    except Exception:
        pass

    return run


async def _await_session_idle(session_id: str, run_id: Optional[str] = None, timeout_s: float = 600.0) -> str:
    """Wait out the current step's agent turn. Returns a disposition:
      'idle'    turn finished, advance to the next step
      'error'   the agent session errored
      'stopped' the run was manually stopped (full stop)

    For a real run (run_id given) a user PAUSE shows up as the session going
    'stopped' WITHOUT a stop signal; that is not terminal, so we hold here
    until Resume or Stop, keeping the step deadline fresh so a long pause
    doesn't fail the step. The attended test-run driver passes no run_id and
    treats 'stopped' as terminal (no pause/resume there).

    Polls cheaply since agent_manager doesn't expose a per-session completion
    future. Bounded by timeout_s so a stuck step can't hang the runner forever.
    """
    from backend.apps.agents.agent_manager import agent_manager

    hold_on_pause = run_id is not None
    deadline = asyncio.get_event_loop().time() + timeout_s
    while True:
        if run_id is not None and _run_control.get(run_id) == "stop":
            return "stopped"
        sess = agent_manager.sessions.get(session_id)
        if not sess:
            return "idle"
        status = getattr(sess, "status", None)
        if status == "stopped":
            if not hold_on_pause:
                return "stopped"
            # Paused. Hold, and reset the deadline so paused wall-time doesn't count against the step timeout.
            deadline = asyncio.get_event_loop().time() + timeout_s
            await asyncio.sleep(0.1)
            continue
        if status == "error":
            return "error"
        if status == "completed":
            return "idle"
        task = agent_manager.tasks.get(session_id)
        if task is not None and task.done() and status not in ("running", "waiting_approval"):
            return "idle"
        if asyncio.get_event_loop().time() > deadline:
            raise TimeoutError(f"Step exceeded {timeout_s}s on session {session_id}")
        await asyncio.sleep(0.05)
