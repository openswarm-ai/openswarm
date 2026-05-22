import asyncio
import logging
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Optional

from fastapi import HTTPException, Header, Request

from backend.config.Apps import SubApp
from backend.apps.workflows.models import (
    Workflow,
    WorkflowCreate,
    WorkflowUpdate,
    WorkflowRun,
)
from backend.apps.workflows import storage, scheduler, executor, audit, escalation

logger = logging.getLogger(__name__)


def _scan_cron_for_openswarm() -> list[str]:
    """Surface OS-level scheduled-task entries that reference us.

    macOS + Linux: read `crontab -l`. Windows: query `schtasks` for any
    task whose command/path contains 'openswarm'. Best-effort across all
    three; any failure (no tool installed, permission denied, parse
    error) just returns []. Surfaced to the FE so the Workflows hub can
    offer a one-click migration banner to convert into native workflows.
    """
    import subprocess
    import platform as _platform
    findings: list[str] = []
    if _platform.system() == "Windows":
        try:
            proc = subprocess.run(
                ["schtasks", "/query", "/fo", "CSV", "/v"],
                capture_output=True, text=True, timeout=4,
            )
            if proc.returncode != 0:
                return []
            for line in (proc.stdout or "").splitlines():
                if "openswarm" in line.lower() and not line.lstrip().startswith('"#'):
                    findings.append(line.strip())
        except Exception:
            return []
        return findings
    # macOS + Linux
    try:
        proc = subprocess.run(
            ["crontab", "-l"],
            capture_output=True, text=True, timeout=2,
        )
        if proc.returncode != 0:
            return []
        out = proc.stdout or ""
        return [line.strip() for line in out.splitlines() if "openswarm" in line.lower() and not line.strip().startswith("#")]
    except Exception:
        return []


_cron_findings: list[str] = []


@asynccontextmanager
async def workflows_lifespan():
    storage.init()
    await scheduler.start()
    # Cheap one-shot scan for prior cron entries that reference us. We
    # don't migrate automatically; the FE shows a banner with a "Convert
    # to OpenSwarm scheduled tasks" button so the user is in control.
    global _cron_findings
    _cron_findings = _scan_cron_for_openswarm()
    try:
        yield
    finally:
        await scheduler.stop()


workflows = SubApp("workflows", workflows_lifespan)


def _derive_icon(wf: Workflow) -> str:
    """Cheap icon hint used until proper auto-icon generation lands.

    Pull the first emoji from the title, falling back to the first
    letter. Keeps the Search list (image 2 annotation) populated without
    waiting on the LLM-based icon generator.
    """
    title = (wf.title or "").strip()
    for ch in title:
        if ord(ch) > 0x2700:
            return ch
    if title:
        return title[:1].upper()
    return "W"


@workflows.router.get("/list")
async def list_workflows(dashboard_id: Optional[str] = None):
    items = storage.list_workflows()
    if dashboard_id:
        items = [w for w in items if not w.dashboard_id or w.dashboard_id == dashboard_id]
    items.sort(key=lambda w: w.updated_at or w.created_at, reverse=True)
    # Enrich with cost_estimate so calendar tooltips and the WorkflowsHub
    # list don't have to round-trip to GET /workflows/{id} per row. Cheap
    # because fires_in_window walks at most ~30 fires per workflow.
    return {"workflows": [_enriched(w) for w in items]}


@workflows.router.post("/create")
async def create_workflow(body: WorkflowCreate):
    actions = body.actions
    # Scheduled workflows default to freeze=on for safety. The user can
    # flip "Full agent access" in the editor with an explicit confirm.
    # Source-session creates inherit the chat's tool choices so we leave
    # them alone there (the source session itself already vetted the
    # blast radius).
    if body.schedule.enabled and not actions.freeze and not body.source_session_id:
        actions = actions.model_copy(update={"freeze": True})
    wf = Workflow(
        title=body.title,
        description=body.description,
        icon=body.icon,
        system_prompt=body.system_prompt,
        use_synced_prompt=body.use_synced_prompt,
        steps=body.steps,
        actions=actions,
        schedule=body.schedule,
        permissions=body.permissions or [],
        source_session_id=body.source_session_id,
        dashboard_id=body.dashboard_id,
        model=body.model or "sonnet",
        mode=body.mode or "agent",
        provider=body.provider or "anthropic",
        cost_cap_usd_monthly=body.cost_cap_usd_monthly,
    )
    if not wf.icon:
        wf.icon = _derive_icon(wf)
    if wf.schedule.enabled:
        wf.next_run_at = scheduler.compute_next_fire(wf)
    # Force-generate title + description from the steps in a single aux
    # call. Previously we only filled missing description, leaving stale
    # session names ("Inbox check") as titles. One round-trip, both
    # fields, overwrites whatever shallow draft the FE sent.
    try:
        title, description = await _generate_title_and_description(wf)
        if title:
            wf.title = title
        if description:
            wf.description = description
    except Exception:
        pass
    storage.save_workflow(wf)
    scheduler.kick()
    return _enriched(wf)


async def _generate_title_and_description(wf: Workflow) -> tuple[str, str]:
    """Single aux-model call returning (title, description).

    Uses strict JSON output so both fields come back in one round-trip.
    Returns ("", "") on any failure so the caller can write back
    unconditionally without dropping the workflow create.
    """
    if not wf.steps:
        return "", ""
    try:
        from backend.apps.agents.providers.registry import resolve_aux_model
        from backend.apps.agents.providers.registry import get_anthropic_client_for_model
        from backend.apps.settings.settings import load_settings as _ls
    except Exception:
        return "", ""
    settings = _ls()
    try:
        aux_model, _ = await resolve_aux_model(settings, preferred_tier="haiku")
        client = get_anthropic_client_for_model(settings, aux_model)
    except Exception:
        return "", ""
    steps_lines = "\n".join(f"{i+1}. {s.text}" for i, s in enumerate(wf.steps) if s.text)
    prompt = (
        "You name and describe a saved automation routine that the user "
        "can re-run later. The routine is defined ONLY by the numbered "
        "steps below; treat those as the user's instructions to the "
        "agent.\n\n"
        "Return STRICT JSON, nothing else, no code fence:\n"
        "  {\"title\": string, \"description\": string}\n\n"
        "title rules:\n"
        "- 2 to 5 words, Title Case\n"
        "- Starts with a verb-noun pair when possible (e.g. \"Summarize "
        "Daily Emails\")\n"
        "- No emoji, no quotes, no trailing punctuation\n\n"
        "description rules:\n"
        "- 1 to 2 sentences, under 30 words total\n"
        "- Describes the concrete WORK the routine performs for the user, "
        "not metadata about itself. Examples of GOOD output:\n"
        "    \"Reads recent Gmail, ranks urgency, and emails you a PDF "
        "digest each Sunday at 9am.\"\n"
        "    \"Pulls today's calendar plus inbox, writes a Notion brief, "
        "and texts you the link.\"\n"
        "- Examples of BAD output you MUST AVOID verbatim:\n"
        "    \"This is an AI-generated description...\"\n"
        "    \"Auto-generated description used to wrap workflows...\"\n"
        "    Any sentence that talks about the description itself\n"
        "- Start with a verb. Do NOT start with \"This\", \"A\", \"An\", "
        "\"The workflow\", \"This routine\".\n\n"
        f"Steps:\n{steps_lines}"
    )
    import json
    import re as _re

    def _extract_json_object(s: str) -> Optional[dict]:
        """Find the first {...} block and json.loads it. Handles code
        fences, prose preambles, and trailing chatter that some aux
        models like to add."""
        s = s.strip()
        if s.startswith("```"):
            s = _re.sub(r"^```(?:json)?\s*", "", s, flags=_re.IGNORECASE)
            s = _re.sub(r"\s*```\s*$", "", s)
        # Greedy brace match; falls through to direct json.loads if no
        # braces are visible at all.
        start = s.find("{")
        end = s.rfind("}")
        if start != -1 and end != -1 and end > start:
            s = s[start : end + 1]
        try:
            return json.loads(s)
        except Exception:
            return None

    try:
        # Prefill the assistant turn with `{` so the model is steered into
        # emitting JSON from the first token. The Anthropic API treats a
        # trailing assistant message as a prefill; we'll glue it back on
        # before parsing.
        resp = await client.messages.create(
            model=aux_model,
            max_tokens=240,
            messages=[
                {"role": "user", "content": prompt},
                {"role": "assistant", "content": "{"},
            ],
        )
        text = ""
        if isinstance(resp.content, list):
            for block in resp.content:
                if getattr(block, "type", None) == "text":
                    text += getattr(block, "text", "")
        raw = "{" + text.strip() if not text.strip().startswith("{") else text.strip()
        data = _extract_json_object(raw)
        if not data:
            logger.warning("description gen: failed to parse aux model output: %s", raw[:400])
            return "", ""
        title = (data.get("title") or "").strip()[:80]
        description = (data.get("description") or "").strip()[:500]
        if not description:
            logger.warning("description gen: empty description from aux model. Raw: %s", raw[:400])
        return title, description
    except Exception as e:
        logger.warning("description gen: aux model call failed: %s", e)
        return "", ""


def _last_run_cost(wid: str) -> float:
    for r in storage.list_runs(wid, limit=10):
        if r.status in ("success", "ran_late") and r.cost_usd:
            return float(r.cost_usd)
    return 0.0


def _enriched(wf: Workflow) -> dict:
    """Serialize a workflow with a cost_estimate block attached.

    monthly_usd assumes future fires cost the same as the last successful
    fire. Surfaces honestly as "at last run's cost" in the UI so users
    understand it's a projection, not a quota.
    """
    base = wf.model_dump(mode="json")
    last = _last_run_cost(wf.id)
    fires = scheduler.fires_in_window(wf, days=30)
    base["cost_estimate"] = {
        "monthly_usd": round(last * fires, 4),
        "last_run_usd": round(last, 4),
        "fires_per_month": fires,
    }
    return base


@workflows.router.get("/active")
async def list_active_runs():
    """Snapshot of currently-running workflow runs. Used by the tray and
    the auto-updater veto."""
    return {"active": scheduler.list_active()}


@workflows.router.post("/pause-all")
async def pause_all_schedules():
    storage.set_paused(True)
    scheduler.kick()
    return {"paused": True}


@workflows.router.post("/resume-all")
async def resume_all_schedules():
    storage.set_paused(False)
    scheduler.kick()
    return {"paused": False}


@workflows.router.get("/paused")
async def get_paused_state():
    return {"paused": storage.get_paused()}


@workflows.router.get("/cron/findings")
async def cron_findings():
    """Cron entries we found at startup that reference OpenSwarm. The
    FE renders a one-time banner inviting users to convert them; we
    return the raw lines so the user can verify before migrating."""
    return {"entries": list(_cron_findings)}


@workflows.router.get("/cloud/sms/status")
async def cloud_sms_status():
    """Probe used by the FE to decide whether to show the 'falls back to
    in-app notify' acknowledgement on the text/call tiers. Returns
    enabled=False until the cloud SMS bridge ships."""
    return {"enabled": False}


@workflows.router.post("/runs/{run_id}/ack")
async def ack_run(run_id: str):
    cancelled = escalation.cancel(run_id)
    return {"acked": True, "had_pending_escalation": cancelled}


@workflows.router.get("/runs/{run_id}/escalation")
async def get_run_escalation(run_id: str):
    state = escalation.status(run_id)
    return {"state": state}


@workflows.router.get("/{workflow_id}")
async def get_workflow(workflow_id: str):
    wf = storage.get_workflow(workflow_id)
    if not wf:
        raise HTTPException(status_code=404, detail="Workflow not found")
    return _enriched(wf)


@workflows.router.get("/{workflow_id}/audit")
async def get_workflow_audit(workflow_id: str, limit: int = 50):
    wf = storage.get_workflow(workflow_id)
    if not wf:
        raise HTTPException(status_code=404, detail="Workflow not found")
    return {"entries": audit.read_tail(workflow_id, limit=limit)}


@workflows.router.patch("/{workflow_id}")
async def update_workflow(
    workflow_id: str,
    body: WorkflowUpdate,
    if_match: Optional[str] = Header(default=None, alias="If-Match"),
):
    wf = storage.get_workflow(workflow_id)
    if not wf:
        raise HTTPException(status_code=404, detail="Workflow not found")
    # Optimistic concurrency: if the client passed If-Match, verify it
    # matches the current updated_at. Stale writes (another window or a
    # mid-edit background fire) get a 409 so the FE can prompt to reload
    # instead of silently clobbering the other actor's changes. Missing
    # header = legacy client, allow through (back-compat with the
    # frontend's pre-409 code path; FE rolls out If-Match immediately).
    if if_match:
        current_stamp = wf.updated_at.isoformat() if hasattr(wf.updated_at, "isoformat") else str(wf.updated_at)
        # Strip quotes a well-behaved HTTP client might add per RFC 7232.
        if if_match.strip().strip('"') != current_stamp:
            raise HTTPException(
                status_code=409,
                detail={
                    "error": "stale_update",
                    "message": "This workflow changed in another window or by a recent run. Reload and try again.",
                    "current_updated_at": current_stamp,
                },
            )
    before = wf.model_dump(mode="json")
    data = body.model_dump(exclude_unset=True)
    for k, v in data.items():
        setattr(wf, k, v)
    wf.updated_at = datetime.now()
    if not wf.icon:
        wf.icon = _derive_icon(wf)
    wf.next_run_at = scheduler.compute_next_fire(wf) if wf.schedule.enabled else None
    storage.save_workflow(wf)
    audit.log_change(wf.id, "user", before, wf.model_dump(mode="json"))
    scheduler.kick()
    return _enriched(wf)


@workflows.router.delete("/{workflow_id}")
async def delete_workflow(workflow_id: str):
    existed = storage.delete_workflow(workflow_id)
    if not existed:
        raise HTTPException(status_code=404, detail="Workflow not found")
    scheduler.kick()
    return {"ok": True}


@workflows.router.post("/{workflow_id}/run")
async def run_workflow_now(workflow_id: str):
    wf = storage.get_workflow(workflow_id)
    if not wf:
        raise HTTPException(status_code=404, detail="Workflow not found")
    # executor.execute() owns the run record. Don't pre-create a stub here
    # or we end up with two rows per manual fire (one orphan "running"
    # row from this handler plus the real one from the executor).
    pre_ids = {r.id for r in storage.list_runs(wf.id, limit=10)}
    asyncio.create_task(executor.execute(wf, triggered_by="manual"))

    # Poll briefly for the newly created run id. We also surface the
    # run's status + error string when it lands quickly (e.g. cost-cap
    # short-circuit, _running collision) so the FE can render a toast
    # instead of silently switching to History.
    for _ in range(25):
        for r in storage.list_runs(wf.id, limit=10):
            if r.id not in pre_ids and r.triggered_by == "manual":
                return {
                    "run_id": r.id,
                    "status": r.status,
                    "error": r.error,
                }
        await asyncio.sleep(0.01)
    return {"run_id": "", "status": None, "error": None}


@workflows.router.get("/{workflow_id}/runs")
async def list_workflow_runs(workflow_id: str, limit: int = 50):
    wf = storage.get_workflow(workflow_id)
    if not wf:
        raise HTTPException(status_code=404, detail="Workflow not found")
    runs = storage.list_runs(workflow_id, limit=limit)
    return {"runs": [r.model_dump(mode="json") for r in runs]}
