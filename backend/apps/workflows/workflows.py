import asyncio
import logging
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Optional

from fastapi import HTTPException, Header, Query, Request

from backend.config.Apps import SubApp
from backend.apps.workflows.models import (
    Workflow,
    WorkflowCreate,
    WorkflowUpdate,
    WorkflowRun,
    WorkflowStep,
    DraftCommitBody,
    AskRunBody,
    MissedRunAction,
    GenerateMetadataRequest,
    GenerateMetadataResponse,
)
from backend.apps.workflows import storage, scheduler, executor, audit, escalation

logger = logging.getLogger(__name__)

# Fixed opener for an existing workflow's edit chat. Deterministic on purpose,
# no aux LLM call, so it never drifts and always lays out what the user can do.
EDIT_AGENT_INTRO = (
    "Here's your workflow's edit space. Tell me what you want and I'll handle it:\n\n"
    "- Add, remove, or reorder steps\n"
    "- Rewrite what any step does\n"
    "- Connect tools it needs (email, calendar, browsing, and more)\n"
    "- Test a run to see it work end to end\n\n"
    "You can ask me directly here, or edit it yourself in the panel on the right: "
    "Schedule sets when and how often it runs, and Steps is what it does, in order."
)


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


def _source_tool_name(value) -> str:
    if not isinstance(value, str):
        return ""
    name = value.strip()
    return name if name else ""


def _collect_tool_names_from_content(content, out: set[str]) -> None:
    if isinstance(content, list):
        for item in content:
            _collect_tool_names_from_content(item, out)
        return
    if not isinstance(content, dict):
        return
    block_type = content.get("type")
    if block_type == "tool_use":
        name = _source_tool_name(content.get("name") or content.get("tool"))
        if name:
            out.add(name)
    for key in ("tool_name", "tool"):
        name = _source_tool_name(content.get(key))
        if name:
            out.add(name)
    nested = content.get("content")
    if nested is not content:
        _collect_tool_names_from_content(nested, out)


def p_source_session_memory(session_id: Optional[str]) -> tuple[dict[str, str], list[str], Optional[list[str]]]:
    if not session_id:
        return {}, [], None
    try:
        from backend.apps.agents.agent_manager import agent_manager
        sess = agent_manager.sessions.get(session_id)
        allowed_tools = list(getattr(sess, "allowed_tools", [])) if sess is not None else None
        decisions = getattr(sess, "approval_decisions", None) if sess is not None else None
        messages = getattr(sess, "messages", None) if sess is not None else None
        tool_latencies = getattr(sess, "tool_latencies", None) if sess is not None else None
        if decisions is None:
            from backend.apps.agents.manager.session.session_store import _load_session_data
            data = _load_session_data(session_id) or {}
            decisions = data.get("approval_decisions") or []
            messages = data.get("messages") or []
            tool_latencies = data.get("tool_latencies") or {}
            raw_allowed = data.get("allowed_tools")
            allowed_tools = list(raw_allowed) if isinstance(raw_allowed, list) else None
    except Exception:
        return {}, [], None
    approvals: dict[str, str] = {}
    tools: set[str] = set()
    for entry in decisions or []:
        if not isinstance(entry, dict):
            continue
        tool = _source_tool_name(entry.get("tool"))
        if tool:
            tools.add(tool)
        if entry.get("sensitive_pattern"):
            continue
        behavior = entry.get("behavior")
        if tool and behavior in ("allow", "deny"):
            approvals[tool] = behavior
    if isinstance(tool_latencies, dict):
        for tool in tool_latencies.keys():
            name = _source_tool_name(tool)
            if name:
                tools.add(name)
    for msg in messages or []:
        role = getattr(msg, "role", None) if not isinstance(msg, dict) else msg.get("role")
        content = getattr(msg, "content", None) if not isinstance(msg, dict) else msg.get("content")
        if role == "tool_call":
            tool_name = getattr(msg, "tool_name", None) if not isinstance(msg, dict) else msg.get("tool_name")
            name = _source_tool_name(tool_name)
            if name:
                tools.add(name)
        _collect_tool_names_from_content(content, tools)
    return approvals, sorted(tools), allowed_tools


def p_prune_step_tool_usage(wf: Workflow) -> None:
    live_ids = {s.id for s in wf.steps}
    wf.step_tool_usage = {
        sid: dict(tools)
        for sid, tools in (wf.step_tool_usage or {}).items()
        if sid in live_ids and isinstance(tools, dict)
    }


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


def _normalize_schedule_state(wf: Workflow, source_allowed_tools: Optional[list[str]] = None) -> None:
    if wf.schedule.timezone == "local" and wf.schedule.enabled:
        wf.schedule.timezone = scheduler.host_timezone_name()
    if wf.schedule.enabled and not scheduler.is_schedule_configured(wf.schedule):
        wf.schedule.enabled = False
    if wf.schedule.enabled and wf.schedule.repeat_unit == "month" and wf.schedule.day_of_month is None:
        tz = scheduler._resolve_tz(wf.schedule.timezone)
        wf.schedule.day_of_month = datetime.now(timezone.utc).astimezone(tz).day
    if wf.schedule.enabled and scheduler.is_schedule_configured(wf.schedule) and not wf.actions.freeze:
        if wf.source_session_id:
            allowed = source_allowed_tools
            if allowed is None:
                _, _, allowed = p_source_session_memory(wf.source_session_id)
            if allowed is not None:
                wf.actions = wf.actions.model_copy(update={
                    "freeze": True,
                    "configured_sets": list(allowed),
                })
        else:
            wf.actions = wf.actions.model_copy(update={"freeze": True})
    wf.next_run_at = scheduler.compute_next_fire(wf) if wf.schedule.enabled else None


def _has_nonempty_steps(steps: list[WorkflowStep] | None) -> bool:
    return any(bool((s.text or "").strip()) for s in (steps or []))


def _parse_calendar_bound(value: str, label: str) -> datetime:
    raw = (value or "").strip()
    if raw.endswith("Z"):
        raw = raw[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(raw)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Invalid {label} timestamp")
    if dt.tzinfo is None:
        raise HTTPException(status_code=400, detail=f"{label} timestamp must include a timezone")
    return dt.astimezone(timezone.utc)


@workflows.router.post("/create")
async def create_workflow(body: WorkflowCreate):
    if not body.unsaved and not _has_nonempty_steps(body.steps):
        raise HTTPException(status_code=400, detail="Workflow must have at least one step")
    actions = body.actions
    wf = Workflow(
        title=body.title,
        description=body.description,
        icon=body.icon,
        color=body.color,
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
        auto_named=body.auto_named,
        unsaved=body.unsaved,
    )
    source_approvals, source_tools, source_allowed_tools = p_source_session_memory(body.source_session_id)
    wf.remembered_approvals = source_approvals
    wf.source_tools = source_tools
    # Convert-from-chat passes the steps signature so the workflow counts as
    # already validated (the chat already prompted for permissions); a blank
    # "New" create leaves it None so the first schedule warns to test first.
    wf.tested_signature = body.tested_signature
    if not wf.icon:
        wf.icon = _derive_icon(wf)
    _normalize_schedule_state(wf, source_allowed_tools=source_allowed_tools)
    # Force-generate title + description + per-step labels from the steps
    # in a single aux call. Previously we only filled missing description,
    # leaving stale session names ("Inbox check") as titles. Step labels
    # are the 3-6 word at-a-glance headlines surfaced in StepList; without
    # them the UI falls back to truncated raw prompts.
    # When the FE already generated metadata at preview time it ships the title,
    # description, and per-step labels on the body, so we skip the aux call here.
    if not body.metadata_generated:
        try:
            title, description, labels = await _generate_workflow_metadata(wf)
            # Respect a user-supplied title (auto_named=False); only auto-fill the
            # name + description while the workflow is still auto-named. Labels are
            # always safe to fill since they don't override a user's title.
            if wf.auto_named:
                if title:
                    wf.title = title
                if description:
                    wf.description = description
            if labels and len(labels) == len(wf.steps):
                for i, lab in enumerate(labels):
                    if lab:
                        wf.steps[i].label = lab
        except Exception:
            pass
    storage.save_workflow(wf)
    scheduler.kick()
    enriched = _enriched(wf)
    try:
        from backend.apps.agents.core.ws_manager import ws_manager
        await ws_manager.broadcast_global("workflow:updated", {
            "workflow_id": wf.id,
            "workflow": enriched,
        })
    except Exception:
        pass
    return enriched


@workflows.router.post("/generate-metadata")
async def generate_workflow_metadata(body: GenerateMetadataRequest) -> GenerateMetadataResponse:
    # Preview-time naming for the convert-to-workflow draft. Generates without
    # persisting so the card can show a real title before the user saves.
    wf = Workflow(steps=body.steps, model=body.model or "sonnet")
    title, description, labels = await _generate_workflow_metadata(wf)
    return GenerateMetadataResponse(title=title, description=description, step_labels=labels)


async def _generate_workflow_metadata(wf: Workflow) -> tuple[str, str, list[str]]:
    """(title, description, step_labels) for the workflow's live steps. Thin
    wrapper over p_generate_metadata_for_steps."""
    return await p_generate_metadata_for_steps(wf.steps, wf.model)


async def p_generate_metadata_for_steps(
    steps: list[WorkflowStep], model: Optional[str]
) -> tuple[str, str, list[str]]:
    """Single aux-model call returning (title, description, step_labels).

    One round-trip for all three so we don't burn 3x aux cost. Returns
    ("", "", []) on any failure; caller writes back unconditionally. Takes an
    explicit step list so the draft-build path can name from draft_steps before
    they're committed onto the live workflow.
    """
    if not steps:
        return "", "", []
    try:
        from backend.apps.agents.providers.registry import resolve_aux_model, get_api_type
        from backend.apps.settings.credentials import get_anthropic_client_for_model
        from backend.apps.settings.settings import load_settings as _ls
    except Exception:
        return "", "", []
    settings = _ls()
    try:
        # Stay on the family the user is actually paying for (same as
        # generate_title); without primary_api the aux call can resolve to a
        # lane that returns nothing on subscription setups.
        aux_model, _ = await resolve_aux_model(
            settings, preferred_tier="haiku", primary_api=get_api_type(model),
        )
        client = get_anthropic_client_for_model(settings, aux_model)
    except Exception:
        return "", "", []
    steps_lines = "\n".join(f"{i+1}. {s.text}" for i, s in enumerate(steps) if s.text)
    n_steps = len(steps)
    prompt = (
        "You name and describe a saved automation routine that the user "
        "can re-run later, AND produce a short at-a-glance label for "
        "each step. The routine is defined ONLY by the numbered steps "
        "below; treat those as the user's instructions to the agent.\n\n"
        "Return STRICT JSON, nothing else, no code fence:\n"
        '  {"title": string, "description": string, "step_labels": [string, ...]}\n\n'
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
        "- Start with a verb. Do NOT start with \"This\", \"A\", \"An\", "
        "\"The workflow\", \"This routine\".\n\n"
        f"step_labels rules:\n"
        f"- EXACTLY {n_steps} entries, one per step, same order.\n"
        "- Each label: 3 to 6 words, Sentence case.\n"
        "- Imperative verb-led (\"Summarize emails & calendar\", \"Make "
        "brief in notion\", \"Email brief link to me\").\n"
        "- No trailing punctuation, no quotes, no emoji.\n"
        "- Should read as the human-friendly NAME of the step, NOT a "
        "restatement of the prompt.\n\n"
        f"Steps:\n{steps_lines}"
    )
    import json
    import re as _re

    def _extract_json_object(s: str) -> Optional[dict]:
        s = s.strip()
        if s.startswith("```"):
            s = _re.sub(r"^```(?:json)?\s*", "", s, flags=_re.IGNORECASE)
            s = _re.sub(r"\s*```\s*$", "", s)
        start = s.find("{")
        end = s.rfind("}")
        if start != -1 and end != -1 and end > start:
            s = s[start : end + 1]
        try:
            return json.loads(s)
        except Exception:
            return None

    try:
        # Stream, don't use messages.create: 9router's non-streaming response
        # translator drops `content` for some provider lanes (same reason
        # generate_title streams), which left the title empty. Streaming also
        # means no assistant-prefill hack; _extract_json_object finds the
        # object even if the model wraps it in prose or a code fence.
        chunks: list[str] = []
        async with client.messages.stream(
            model=aux_model,
            max_tokens=400 + n_steps * 30,
            messages=[{"role": "user", "content": prompt}],
        ) as stream:
            async for chunk in stream.text_stream:
                chunks.append(chunk)
        raw = "".join(chunks)
        data = _extract_json_object(raw)
        if not data:
            logger.warning("workflow meta gen: failed to parse aux model output: %s", raw[:400])
            return "", "", []
        title = (data.get("title") or "").strip()[:80]
        description = (data.get("description") or "").strip()[:500]
        raw_labels = data.get("step_labels") or []
        labels = [str(x or "").strip()[:60] for x in raw_labels] if isinstance(raw_labels, list) else []
        return title, description, labels
    except Exception as e:
        logger.warning("workflow meta gen: aux model call failed: %s", e)
        return "", "", []


_PLACEHOLDER_TITLES = {"", "New workflow", "Untitled workflow", "Scheduled workflow"}


def p_fallback_title_for_steps(steps: list[WorkflowStep]) -> str:
    """Deterministic title derived from the steps, used when the aux model is
    unreachable. A step-based name beats leaving the workflow as "New workflow".
    Takes the first meaningful step's label (or its text), keeps it to ~5 words,
    and Title-Cases it while preserving already-capitalized tokens (Gmail)."""
    for s in steps:
        base = ((s.label or "") or (s.text or "")).strip()
        if base:
            words = base.split()[:5]
            return " ".join(w.capitalize() if w.islower() else w for w in words)[:60]
    return ""


def p_short_step_label(text: str) -> str:
    """Deterministic short label from a step's prompt, used when the aux model is
    unreachable or hands back a mis-sized list. Without it an unlabeled step falls
    back to showing its whole prompt as the title. First ~6 words, sentence case."""
    base = (text or "").strip()
    if not base:
        return ""
    label = " ".join(base.split()[:6])
    return (label[:1].upper() + label[1:])[:48]


async def p_relabel_steps(
    wf: Workflow, before_steps: list[dict], steps: list[WorkflowStep], model: Optional[str]
) -> None:
    """Generate short per-step labels for changed/unlabeled steps, and name the
    workflow once from the steps. Works on any step list (live `steps` or the
    build `draft_steps`) so naming fires the moment a step lands, agent or manual.

    Auto-name fires only while the title is still a placeholder ("Untitled
    workflow") and the workflow is still auto-named: that names it once on the
    first real step, never drifts on later edits, and stops two paths (the draft
    stage and its commit) from both spending an aux call on the same title."""
    before_by_id = {s.get("id"): s for s in before_steps}
    regen_idxs: list[int] = []
    content_changed = len(before_steps) != len(steps)
    for i, step in enumerate(steps):
        old = before_by_id.get(step.id)
        old_text = (old or {}).get("text") or ""
        old_label = (old or {}).get("label") or ""
        new_label = (step.label or "").strip()
        if old is None or old_text != step.text:
            content_changed = True
        if old is not None and old_text == step.text:
            if not new_label and old_label:
                step.label = old_label
            continue
        # A step with no distinct user label gets one generated from its prompt.
        if not (new_label and new_label != old_label):
            regen_idxs.append(i)
    need_autoname = (
        wf.auto_named
        and (wf.title or "").strip() in _PLACEHOLDER_TITLES
        and content_changed
        and any(s.text for s in steps)
    )
    if not regen_idxs and not need_autoname:
        return
    try:
        title, description, labels = await p_generate_metadata_for_steps(steps, model)
    except Exception:
        return
    # One aux call covers labels AND auto-naming. A manual rename sets
    # auto_named=False, so the title/description below are left untouched then.
    if need_autoname:
        if title:
            wf.title = title
        else:
            # Aux model returned nothing (flaky lane / rate limit). Fall back to
            # a step-derived name so the workflow doesn't stay "Untitled workflow".
            fb = p_fallback_title_for_steps(steps)
            if fb:
                wf.title = fb
        if description:
            wf.description = description
    # Per-index, not all-or-nothing: the cheap aux tier sometimes returns a
    # mis-sized (or non-list) step_labels, which used to drop EVERY label and
    # leave the raw prompt showing as the step title. Take whatever aux gave for
    # this slot, else a deterministic short label so a step is never its prompt.
    for i in regen_idxs:
        aux = labels[i].strip() if i < len(labels) and labels[i] else ""
        new_label = aux or p_short_step_label(steps[i].text)
        if new_label:
            steps[i].label = new_label


async def p_relabel_changed_steps(wf: Workflow, before_steps: list[dict]) -> None:
    await p_relabel_steps(wf, before_steps, wf.steps, wf.model)


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
    base["has_draft"] = wf.draft_steps is not None
    return base


def p_render_test_transcript(messages: list, max_chars: int = 14000) -> str:
    """Flatten a Test Agent's messages into a readable role-tagged transcript.

    Tail-biased cap so the end (where a run succeeds or blows up) always
    survives, protecting the Edit Agent's context window.
    """
    import json as json_mod
    lines: list[str] = []
    for m in messages:
        if getattr(m, "hidden", False):
            continue
        role = (getattr(m, "role", "") or "?").upper()
        content = getattr(m, "content", "")
        if isinstance(content, str):
            text = content
        elif isinstance(content, list):
            parts: list[str] = []
            for b in content:
                if not isinstance(b, dict):
                    parts.append(str(b))
                    continue
                kind = b.get("type")
                if kind == "text":
                    parts.append(str(b.get("text") or ""))
                elif kind == "tool_use":
                    parts.append(f"[tool {b.get('name')}] {json_mod.dumps(b.get('input') or {})[:300]}")
                elif kind == "tool_result":
                    inner = b.get("content")
                    parts.append(f"[result] {inner if isinstance(inner, str) else json_mod.dumps(inner)[:300]}")
                else:
                    parts.append(str(b)[:200])
            text = "\n".join(p for p in parts if p)
        else:
            text = ""
        if text.strip():
            lines.append(f"{role}: {text.strip()}")
    out = "\n\n".join(lines)
    if len(out) > max_chars:
        out = "...(earlier turns trimmed)...\n\n" + out[-max_chars:]
    return out


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


@workflows.router.get("/runs/all")
async def list_all_runs(limit: int = 200):
    """Flat, newest-first log of every workflow run across all workflows.
    Backs the dashboard History popover's Scheduled tasks tab."""
    runs = storage.list_all_runs(limit=limit)
    return {"runs": [r.model_dump(mode="json") for r in runs]}


@workflows.router.get("/missed")
async def list_missed_runs(limit: int = 50):
    """Pending fires that elapsed while the app was closed, newest-first.
    Backs the launch-time review card."""
    missed = sorted(storage.list_missed(), key=lambda m: m.scheduled_for, reverse=True)
    out: list[dict] = []
    for m in missed[:limit]:
        wf = storage.get_workflow(m.workflow_id)
        if not wf:
            continue
        out.append({
            "id": m.id,
            "workflow_id": m.workflow_id,
            "workflow_title": wf.title,
            "workflow_icon": wf.icon,
            "scheduled_for": m.scheduled_for.isoformat() if isinstance(m.scheduled_for, datetime) else m.scheduled_for,
        })
    return {"missed": out}


@workflows.router.post("/missed/run")
async def run_missed_runs(body: MissedRunAction):
    """Run the selected missed fires now. Each lands in History as ran_late.
    Fires of the same workflow run sequentially (the executor blocks
    concurrent runs of one workflow)."""
    wanted = set(body.ids)
    selected = [m for m in storage.list_missed() if m.id in wanted]
    if not selected:
        return {"started": 0}
    storage.remove_missed([m.id for m in selected])
    by_wf: dict[str, list[datetime]] = {}
    for m in sorted(selected, key=lambda m: m.scheduled_for):
        by_wf.setdefault(m.workflow_id, []).append(m.scheduled_for)
    started = 0
    for wid, fors in by_wf.items():
        wf = storage.get_workflow(wid)
        if not wf:
            continue
        started += len(fors)
        asyncio.create_task(scheduler.run_missed_sequence(wf, fors))
    return {"started": started}


@workflows.router.post("/missed/dismiss")
async def dismiss_missed_runs(body: MissedRunAction):
    """Drop the selected missed fires, logging each as a skipped run so the
    workflow's history still shows it happened."""
    wanted = set(body.ids)
    selected = [m for m in storage.list_missed() if m.id in wanted]
    storage.remove_missed([m.id for m in selected])
    dismissed = 0
    for m in selected:
        wf = storage.get_workflow(m.workflow_id)
        if not wf:
            continue
        scheduler.record_skipped(wf, m.scheduled_for, "You dismissed this missed run")
        dismissed += 1
    return {"dismissed": dismissed}


@workflows.router.get("/calendar")
async def list_calendar_events(
    from_: str = Query(..., alias="from"),
    to: str = Query(...),
    dashboard_id: Optional[str] = None,
):
    start_utc = _parse_calendar_bound(from_, "from")
    end_utc = _parse_calendar_bound(to, "to")
    if end_utc <= start_utc:
        raise HTTPException(status_code=400, detail="to must be after from")
    items = storage.list_workflows()
    if dashboard_id:
        items = [w for w in items if not w.dashboard_id or w.dashboard_id == dashboard_id]
    events: list[dict] = []
    for wf in items:
        for fire_at in scheduler.occurrences_between(wf, start_utc, end_utc):
            events.append({
                "workflow_id": wf.id,
                "fire_at": fire_at.astimezone(timezone.utc).isoformat(),
            })
    events.sort(key=lambda e: (e["fire_at"], e["workflow_id"]))
    return {"events": events}


@workflows.router.get("/deleted")
async def list_deleted_workflows(dashboard_id: Optional[str] = None):
    """Trashed workflows, most-recently-deleted first. Backs the Trash screen."""
    items = storage.list_deleted_workflows()
    if dashboard_id:
        items = [w for w in items if not w.dashboard_id or w.dashboard_id == dashboard_id]
    items.sort(key=lambda w: w.deleted_at or w.created_at, reverse=True)
    return {"workflows": [_enriched(w) for w in items]}


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
    # A user-initiated title rename locks the name so later step edits don't
    # auto-rename over it. Only an actual change counts, so the full-object
    # editor save (which echoes the current title unchanged) doesn't lock. If
    # the FE passes auto_named explicitly, that wins (handled by setattr below).
    if "title" in data and "auto_named" not in data and data.get("title") != before.get("title"):
        wf.auto_named = False
    # While an Edit-Agent draft is in flight, ANY PATCH that touches steps
    # stages those steps into the draft instead of the live workflow, so the
    # commit/discard pair is the only thing that moves the live steps. The
    # match is "steps present", not "steps only", so a mixed patch can never
    # leak an edit onto the live steps (which commit would then clobber with
    # the stale draft). The main chat agent never opens an Edit Agent, so it
    # has no draft and falls through to the live path below.
    if wf.draft_steps is not None and "steps" in data:
        before_draft = before.get("draft_steps") or []
        wf.draft_steps = data["steps"]
        # Any non-steps fields in the same patch still apply live (rare from
        # the Edit Agent, whose tools only touch steps).
        for k, v in data.items():
            if k != "steps":
                setattr(wf, k, v)
        # Label the new draft steps and name the workflow off them (once, while
        # still "Untitled"), so the title + step labels fill in the instant a
        # step lands instead of waiting for Save.
        await p_relabel_steps(wf, before_draft, wf.draft_steps, wf.model)
        wf.updated_at = datetime.now()
        _normalize_schedule_state(wf)
        storage.save_workflow(wf)
        enriched = _enriched(wf)
        try:
            from backend.apps.agents.core.ws_manager import ws_manager
            await ws_manager.broadcast_global("workflow:updated", {
                "workflow_id": wf.id,
                "workflow": enriched,
            })
        except Exception:
            pass
        return enriched
    for k, v in data.items():
        setattr(wf, k, v)
    if "steps" in data:
        await p_relabel_changed_steps(wf, before.get("steps") or [])
        p_prune_step_tool_usage(wf)
    wf.updated_at = datetime.now()
    if not wf.icon:
        wf.icon = _derive_icon(wf)
    _normalize_schedule_state(wf)
    storage.save_workflow(wf)
    audit.log_change(wf.id, "user", before, wf.model_dump(mode="json"))
    scheduler.kick()
    # Push the change to every open dashboard so an agent-driven edit (the
    # Edit Agent's add/delete/edit-step tools all PATCH here) refreshes the
    # card live instead of looking stale until the next full refetch.
    enriched = _enriched(wf)
    try:
        from backend.apps.agents.core.ws_manager import ws_manager
        await ws_manager.broadcast_global("workflow:updated", {
            "workflow_id": wf.id,
            "workflow": enriched,
        })
    except Exception:
        pass
    return enriched


@workflows.router.delete("/{workflow_id}")
async def delete_workflow(workflow_id: str):
    """Soft-delete: move to Trash. The record stays on disk with deleted_at
    set so it's hidden from every list and the scheduler but restorable.
    /{id}/purge does the irreversible hard delete."""
    wf = storage.get_workflow(workflow_id)
    if not wf or wf.deleted_at is not None:
        raise HTTPException(status_code=404, detail="Workflow not found")
    wf.deleted_at = datetime.now()
    wf.schedule.enabled = False
    wf.next_run_at = None
    storage.save_workflow(wf)
    # Drop any pending missed fires so a trashed workflow can't haunt the card.
    stale = [m.id for m in storage.list_missed() if m.workflow_id == workflow_id]
    if stale:
        storage.remove_missed(stale)
    scheduler.kick()
    try:
        from backend.apps.agents.core.ws_manager import ws_manager
        await ws_manager.broadcast_global("workflow:deleted", {"workflow_id": workflow_id})
    except Exception:
        pass
    return {"ok": True}


@workflows.router.post("/{workflow_id}/restore")
async def restore_workflow(workflow_id: str):
    """Bring a trashed workflow back. Its schedule stays off (we disabled it
    on delete); the user re-enables it deliberately."""
    wf = storage.get_workflow(workflow_id)
    if not wf or wf.deleted_at is None:
        raise HTTPException(status_code=404, detail="Workflow not in trash")
    wf.deleted_at = None
    storage.save_workflow(wf)
    enriched = _enriched(wf)
    try:
        from backend.apps.agents.core.ws_manager import ws_manager
        await ws_manager.broadcast_global("workflow:updated", {
            "workflow_id": wf.id,
            "workflow": enriched,
        })
    except Exception:
        pass
    return enriched


@workflows.router.delete("/{workflow_id}/purge")
async def purge_workflow(workflow_id: str):
    """Hard delete, only from Trash. Removes the record and its run history."""
    wf = storage.get_workflow(workflow_id)
    if not wf or wf.deleted_at is None:
        raise HTTPException(status_code=404, detail="Workflow not in trash")
    storage.delete_workflow(workflow_id)
    try:
        from backend.apps.agents.core.ws_manager import ws_manager
        await ws_manager.broadcast_global("workflow:deleted", {"workflow_id": workflow_id})
    except Exception:
        pass
    return {"ok": True}


@workflows.router.post("/{workflow_id}/edit-agent-session")
async def edit_agent_session(workflow_id: str):
    """Create (or return existing) Edit Agent session for this workflow.

    The Edit Agent is a real agent session that the user chats with to
    iterate on the workflow (Image #38, #48). It has the workflow context
    pre-loaded in its system prompt and the full default tool surface so
    tool calls render as cards in the chat (Image #48: MCP Activation,
    Gmail Query, etc.).

    Singleton per workflow: re-entering edit mode reattaches to the same
    session so the conversation persists. Frontend stores the returned
    session_id in the workflow card's openCard state.
    """
    wf = storage.get_workflow(workflow_id)
    if not wf:
        raise HTTPException(status_code=404, detail="Workflow not found")
    # Reattach to an in-progress edit session (the user closed and reopened the
    # card mid-edit): resume the existing draft, don't reset it. Save/Discard
    # clear edit_agent_session_id, so once an edit is finished the next entry
    # falls through to the fresh path below: a brand-new chat against the
    # current committed workflow.
    existing_id = getattr(wf, "edit_agent_session_id", None) or None
    if existing_id:
        if wf.draft_steps is None:
            wf.draft_steps = list(wf.steps)
            storage.save_workflow(wf)
        return {"session_id": existing_id}

    # Fresh edit session: snapshot a clean draft from the current committed
    # steps so the Edit Agent's edits stage there (never the live workflow)
    # until the user clicks Save, and Discard reverts to exactly this.
    wf.draft_steps = list(wf.steps)
    storage.save_workflow(wf)

    from backend.apps.agents.core.models import AgentConfig
    from backend.apps.agents.agent_manager import agent_manager
    steps_lines = "\n".join(f"{i+1}. {(s.label or '').strip() or (s.text or '')[:60]}\n   Prompt: {s.text}" for i, s in enumerate(wf.steps))
    # A brand-new workflow ("+ New" in the hub) opens here with zero steps, so
    # frame the agent as a builder rather than a fix-what-exists editor.
    intro = (
        "Help the user iterate on it."
        if wf.steps
        else "This workflow is brand new and has no steps yet. Help the user "
        "build it from scratch: ask what it should do, then add steps with "
        "AddWorkflowStep."
    )
    steps_block = f"Current steps:\n{steps_lines}\n\n" if wf.steps else "It has no steps yet.\n\n"
    system_prompt = (
        f"You are the Edit Agent for the user's saved workflow \"{wf.title}\" "
        f"(id: {wf.id}). {intro} The workflow's purpose: "
        f"{wf.description or '(unspecified)'}.\n\n"
        f"{steps_block}"
        "How to work:\n"
        "1. When the user describes a change, briefly confirm what you'll do.\n"
        "2. If you need to look at files / search / activate an MCP / etc. to "
        "verify your idea, use your tools.\n"
        "3. To change the workflow's steps, call the matching tool. Your edits "
        "STAGE to a pending draft and are fully reversible; nothing touches the "
        "live workflow until the user clicks Save. The card shows your draft as "
        "you go:\n"
        "   - EditWorkflowStep(workflow_id, step_idx, new_text, new_label) to "
        "rewrite a step. ALWAYS pass new_label (a fresh 3-5 word summary) so "
        "the card reflects the change instead of the stale old label.\n"
        "   - AddWorkflowStep(workflow_id, text, label) to add a step.\n"
        "   - DeleteWorkflowStep(workflow_id, step_idx) to remove one.\n"
        "   Confirm via AskUserQuestion FIRST if there's any ambiguity.\n"
        "4. Call TestWorkflow(workflow_id) to spawn a sibling Test Agent that "
        "runs the current draft end-to-end. Use this after a change to verify "
        "it works.\n"
        "5. After a test finishes, call ReadTestTranscript(workflow_id) to read "
        "the Test Agent's full transcript and diagnose what happened before "
        "proposing further edits.\n\n"
        "Be brief in your replies. Don't restate the whole workflow back; the "
        "user can see it. Just confirm what changed and what you're doing.\n"
        "Write like a normal chat: plain conversational sentences. When you "
        "suggest changes, describe them in prose (e.g. \"I could add a step "
        "that...\"). Never dump raw JSON, arrays, or code blocks of step "
        "objects at the user; that belongs in your EditWorkflowStep tool call, "
        "not the message."
    )
    config = AgentConfig(
        name=f"Edit Agent: {wf.title}",
        model=wf.model or "sonnet",
        mode=wf.mode or "agent",
        provider=wf.provider or "anthropic",
        system_prompt=system_prompt,
        allowed_tools=[],
        dashboard_id=wf.dashboard_id,
    )
    session = await agent_manager.launch_agent(config)
    # launch_agent marks the session "running" assuming a turn fires immediately,
    # but an edit-agent chat sits idle until the user sends something. Settle it
    # to idle or the chat is stuck "thinking" forever. An existing workflow also
    # gets a fixed (non-LLM) intro message; a brand-new build stays empty so the
    # compose page can show its own starter prompts.
    session.status = "completed"
    if wf.steps:
        from backend.apps.agents.core.models import Message
        session.messages.append(Message(role="assistant", content=EDIT_AGENT_INTRO))
    try:
        from backend.apps.agents.manager.session.session_store import _save_session
        _save_session(session.id, session.model_dump(mode="json"))
    except Exception:
        logger.debug("could not persist edit-agent session", exc_info=True)
    try:
        from backend.apps.agents.core.ws_manager import ws_manager
        await ws_manager.send_to_session(session.id, "agent:status", {
            "session_id": session.id,
            "status": "completed",
            "session": session.model_dump(mode="json"),
        })
    except Exception:
        logger.debug("could not broadcast edit-agent idle status", exc_info=True)
    try:
        setattr(wf, "edit_agent_session_id", session.id)
        storage.save_workflow(wf)
    except Exception:
        logger.debug("could not persist edit_agent_session_id (legacy schema)", exc_info=True)
    return {"session_id": session.id}


@workflows.router.post("/{workflow_id}/ask-run")
async def ask_run(workflow_id: str, body: AskRunBody):
    """Answer a chat question with a run's transcript folded in as context for
    that one turn. The run rides along hidden (prepend_context), so the user's
    bubble shows just their question and there's no extra "reviewed it" turn.
    """
    wf = storage.get_workflow(workflow_id)
    if not wf:
        raise HTTPException(status_code=404, detail="Workflow not found")
    run = next((r for r in storage.list_runs(workflow_id, limit=200) if r.id == body.run_id), None)
    if not run or not run.session_id:
        raise HTTPException(status_code=404, detail="Run has no chat to attach")

    from backend.apps.agents.agent_manager import agent_manager
    sess = agent_manager.sessions.get(run.session_id)
    if sess is None:
        try:
            sess = await agent_manager.resume_session(run.session_id)
        except ValueError:
            sess = None
    transcript = p_render_test_transcript(getattr(sess, "messages", []) or []) if sess else ""

    edit = await edit_agent_session(workflow_id)
    edit_sid = edit["session_id"]

    status_word = {
        "success": "completed", "ran_late": "completed (late)", "failure": "failed",
    }.get(run.status, run.status)
    context = (
        f"The user is asking about a run of this workflow (run {status_word}). Use the run's full "
        f"transcript below, including each step's tool calls and results, to answer their question. "
        f"Do not summarize unless asked.\n\n=== RUN TRANSCRIPT ===\n{transcript or '(transcript unavailable)'}\n=== END TRANSCRIPT ==="
    )
    try:
        await agent_manager.send_message(
            edit_sid, body.prompt, mode=body.mode, model=body.model, prepend_context=context,
        )
    except Exception:
        logger.exception("ask-run: failed to answer with run context for workflow %s", workflow_id)

    return {"session_id": edit_sid}


async def p_end_edit_session(wf) -> None:
    """End a workflow's Edit-Agent session (after Save or Discard) so the next
    edit opens a brand-new chat against the current workflow instead of
    resuming the old conversation that still references the dropped edits."""
    sid = getattr(wf, "edit_agent_session_id", None)
    wf.edit_agent_session_id = None
    if not sid:
        return
    try:
        from backend.apps.agents.agent_manager import agent_manager
        await agent_manager.close_session(sid)
    except Exception:
        logger.debug("could not close edit session %s", sid, exc_info=True)


def p_sync_model_on_save(wf, model: Optional[str]) -> None:
    """On Save, adopt whatever model the user settled on in the Edit Agent picker as
    the workflow's run model, so a mid-build model switch sticks to scheduled runs.
    Save-only: Discard must not persist a switch the user is throwing away.

    The frontend passes the model it tracks live; we fall back to the backend edit
    session's model for callers that send none (e.g. the Test Agent save button),
    which can be stale until a message is sent but is no worse than before."""
    if model:
        wf.model = model
        return
    sid = getattr(wf, "edit_agent_session_id", None)
    if not sid:
        return
    try:
        from backend.apps.agents.agent_manager import agent_manager
        session = agent_manager.sessions.get(sid)
        if session and session.model:
            wf.model = session.model
    except Exception:
        logger.debug("could not sync model from edit session %s", sid, exc_info=True)


@workflows.router.post("/{workflow_id}/draft/commit")
async def commit_draft(workflow_id: str, body: Optional[DraftCommitBody] = None):
    """Commit the Edit-Agent draft: draft_steps become the live steps."""
    wf = storage.get_workflow(workflow_id)
    if not wf:
        raise HTTPException(status_code=404, detail="Workflow not found")
    if wf.draft_steps is None:
        if not _has_nonempty_steps(wf.steps):
            raise HTTPException(status_code=400, detail="Workflow must have at least one step")
        # Clicking Save is the user committing to this workflow, so reveal it
        # in the hub (clears the "+ New" build-in-progress flag).
        wf.unsaved = False
        p_sync_model_on_save(wf, body.model if body else None)
        if not (body and body.keep_session):
            await p_end_edit_session(wf)
        storage.save_workflow(wf)
        return _enriched(wf)
    before = wf.model_dump(mode="json")
    if not _has_nonempty_steps(wf.draft_steps):
        raise HTTPException(status_code=400, detail="Workflow must have at least one step")
    # Opening a workflow snapshots its own steps into the draft, and the card
    # silently commits that draft. When it matches the live steps that's a no-op:
    # clear it WITHOUT bumping updated_at, so merely viewing a workflow never
    # reorders the "last edited" sidebar. Real edits fall through and bump.
    no_change = [s.model_dump(mode="json") for s in wf.draft_steps] == (before.get("steps") or [])
    wf.unsaved = False
    wf.steps = wf.draft_steps
    wf.draft_steps = None
    if no_change:
        p_prune_step_tool_usage(wf)
        p_sync_model_on_save(wf, body.model if body else None)
        if not (body and body.keep_session):
            await p_end_edit_session(wf)
        storage.save_workflow(wf)
        return _enriched(wf)
    # Clicking Save is the user committing to this workflow, so reveal it in
    # the hub (clears the "+ New" build-in-progress flag).
    await p_relabel_changed_steps(wf, before.get("steps") or [])
    p_prune_step_tool_usage(wf)
    wf.updated_at = datetime.now()
    if not wf.icon:
        wf.icon = _derive_icon(wf)
    _normalize_schedule_state(wf)
    p_sync_model_on_save(wf, body.model if body else None)
    if not (body and body.keep_session):
        await p_end_edit_session(wf)
    storage.save_workflow(wf)
    audit.log_change(wf.id, "user", before, wf.model_dump(mode="json"))
    scheduler.kick()
    enriched = _enriched(wf)
    try:
        from backend.apps.agents.core.ws_manager import ws_manager
        await ws_manager.broadcast_global("workflow:updated", {
            "workflow_id": wf.id,
            "workflow": enriched,
        })
    except Exception:
        pass
    return enriched


@workflows.router.post("/{workflow_id}/draft/discard")
async def discard_draft(workflow_id: str):
    """Throw away the Edit-Agent draft; the live workflow is untouched."""
    wf = storage.get_workflow(workflow_id)
    if not wf:
        raise HTTPException(status_code=404, detail="Workflow not found")
    # Discard wipes the whole edit session: drop the draft AND end the chat, so
    # reopening Edit is a fresh conversation against the current committed steps.
    wf.draft_steps = None
    await p_end_edit_session(wf)
    p_prune_step_tool_usage(wf)
    storage.save_workflow(wf)
    enriched = _enriched(wf)
    try:
        from backend.apps.agents.core.ws_manager import ws_manager
        await ws_manager.broadcast_global("workflow:updated", {
            "workflow_id": wf.id,
            "workflow": enriched,
        })
    except Exception:
        pass
    return enriched


@workflows.router.post("/{workflow_id}/test-run")
async def test_run_workflow(workflow_id: str, body: dict):
    """Spawn a Test Agent session running the (possibly-unsaved) draft.

    Powers Image #39: EditAgentView's Test button. Takes an optional
    draft `steps` array overriding the saved workflow's steps so the
    user can validate edits before persisting. The spawned session is
    a normal agent session; nothing is recorded as a WorkflowRun so
    History stays clean. Returns the new session id; the FE wires it
    to the workflow card via setCardSidecar(kind='testing') and the
    dashboard draws the labeled arrow chip between the two cards.
    """
    wf = storage.get_workflow(workflow_id)
    if not wf:
        raise HTTPException(status_code=404, detail="Workflow not found")
    tested_signature = body.get("signature") if isinstance(body, dict) else None
    draft_steps = (body or {}).get("steps")
    step_entries: list[WorkflowStep]
    if isinstance(draft_steps, list) and draft_steps:
        step_entries = [
            WorkflowStep(**s)
            for s in draft_steps
            if isinstance(s, dict) and str(s.get("text") or "").strip()
        ]
    else:
        # No explicit override: prefer the pending draft so a mid-edit
        # TestWorkflow call (from the Edit Agent itself) tests the draft.
        src = wf.draft_steps if wf.draft_steps is not None else wf.steps
        step_entries = [s for s in src if s.text and s.text.strip()]
    if not step_entries:
        raise HTTPException(status_code=400, detail="Workflow has no steps to test")

    from backend.apps.agents.core.models import AgentConfig
    from backend.apps.agents.agent_manager import (
        agent_manager,
        clear_workflow_approval_memory,
        get_workflow_step_usage,
        set_workflow_approval_memory,
        set_workflow_approval_step,
    )
    from backend.apps.workflows import executor

    resolved_allowed_tools = executor._resolve_allowed_tools(wf)
    config = AgentConfig(
        name=f"{wf.title or 'Workflow'} (test)",
        model=wf.model or "sonnet",
        mode=wf.mode or "agent",
        provider=wf.provider or "anthropic",
        system_prompt=executor._resolve_system_prompt(wf),
        allowed_tools=resolved_allowed_tools if resolved_allowed_tools is not None else [
            "Read", "Edit", "Write", "Bash", "Glob", "Grep", "AskUserQuestion",
        ],
        dashboard_id=wf.dashboard_id,
    )
    session = await agent_manager.launch_agent(config)
    session.workflow_test_state = "running"
    set_workflow_approval_memory(
        session.id,
        decisions=dict(wf.remembered_approvals),
        step_usage={sid: dict(tools) for sid, tools in wf.step_tool_usage.items()},
        remember=executor.p_make_remember_approval(wf.id),
        ask_timeout=600.0,
    )
    # Point the workflow at its latest test session so ReadTestTranscript can
    # fetch the transcript on demand.
    try:
        wf.last_test_session_id = session.id
        storage.save_workflow(wf)
    except Exception:
        logger.debug("could not persist last_test_session_id", exc_info=True)

    async def _set_test_state(state: str) -> None:
        sess = agent_manager.sessions.get(session.id)
        if sess is not None:
            sess.workflow_test_state = state
        try:
            from backend.apps.agents.core.ws_manager import ws_manager
            await ws_manager.broadcast_global("agent:test_state", {
                "session_id": session.id,
                "state": state,
            })
        except Exception:
            pass

    async def _drive_test() -> None:
        final = "complete"
        try:
            for step in step_entries:
                set_workflow_approval_step(session.id, step.id)
                await agent_manager.send_message(session.id, step.text)
                disp = await executor._await_session_idle(session.id)
                if disp == "error":
                    final = "error"
                    return
        except Exception:
            logger.exception("test-run drive loop failed")
            final = "error"
        finally:
            try:
                executor.p_persist_step_tool_usage(
                    wf.id,
                    get_workflow_step_usage(session.id),
                    tested_signature=tested_signature if isinstance(tested_signature, str) else None,
                )
            except Exception:
                logger.exception("test-run step usage persist failed")
            set_workflow_approval_step(session.id, None)
            clear_workflow_approval_memory(session.id)
            await _set_test_state(final)
    asyncio.create_task(_drive_test())

    return {"session_id": session.id}


@workflows.router.get("/{workflow_id}/test-transcript")
async def test_transcript(workflow_id: str):
    """Full transcript of the workflow's most recent Test Agent session.

    Backs the Edit Agent's ReadTestTranscript tool: it needs the Test Agent's
    entire chat history (not just a final output) to diagnose a run.
    """
    wf = storage.get_workflow(workflow_id)
    if not wf:
        raise HTTPException(status_code=404, detail="Workflow not found")
    if not wf.last_test_session_id:
        return {"transcript": "", "status": "none"}
    from backend.apps.agents.agent_manager import agent_manager
    sess = agent_manager.sessions.get(wf.last_test_session_id)
    if sess is None:
        return {"transcript": "", "status": "unavailable"}
    transcript = p_render_test_transcript(getattr(sess, "messages", []) or [])
    return {"transcript": transcript, "status": getattr(sess, "status", "") or ""}


@workflows.router.post("/{workflow_id}/schedule-agent-session")
async def schedule_agent_session(workflow_id: str):
    """Create (or return existing) embedded scheduling-agent session.

    The scheduling agent is a real agent session the user chats with to set
    the workflow's cadence (Image #49). It interprets the user's natural
    language ("every Wednesday at 1pm", "this time, this month") itself and
    commits via UpdateScheduledWorkflow, which is force-gated to "ask" so the
    user gives a final Approve/Deny through ApprovalBar. No deterministic
    pre-parse: the cadence is a model decision.

    Singleton per workflow (same reattach contract as edit-agent-session) so
    re-entering the scheduling view resumes the same conversation.
    """
    wf = storage.get_workflow(workflow_id)
    if not wf:
        raise HTTPException(status_code=404, detail="Workflow not found")
    existing_id = getattr(wf, "schedule_agent_session_id", None) or None
    if existing_id:
        return {"session_id": existing_id}

    from backend.apps.agents.core.models import AgentConfig
    from backend.apps.agents.agent_manager import agent_manager
    now_local = datetime.now().astimezone()
    local_tz = scheduler.host_timezone_name()
    current_dt = now_local.strftime("%A %Y-%m-%d %H:%M %Z")
    system_prompt = (
        f"You are the Scheduling Agent for the user's saved workflow \"{wf.title}\" "
        f"(id: {wf.id}). Your only job is to set when this workflow runs.\n\n"
        f"The current local date and time is {current_dt} in {local_tz}. Resolve relative "
        "phrasing (\"this month\", \"next Wednesday\", \"this time\") against it.\n\n"
        "When the user states a cadence, interpret it yourself and call "
        "UpdateScheduledWorkflow with:\n"
        f"  - workflow_id: \"{wf.id}\"\n"
        "  - schedule_enabled: true\n"
        "  - hour (0-23) and minute (0-59) in the user's local time\n"
        "  - repeat_unit: \"minute\" | \"hour\" | \"day\" | \"week\" | \"month\"\n"
        "  - repeat_every: the interval count (1 unless they say e.g. \"every other\"; "
        "for repeat_unit=\"minute\" the minimum is 15, e.g. \"every 15 minutes\")\n"
        "  - on_days: weekday indices when repeat_unit=\"week\" (Sun=0, Mon=1, ... Sat=6)\n"
        "  - day_of_month: 1-31 when repeat_unit=\"month\" (1 for \"first of the month\")\n"
        f"  - timezone: \"{local_tz}\" unless the user names a different specific zone\n\n"
        "If no AM/PM is given, assume PM for 1-7 and AM for 8-12. If the cadence "
        "is genuinely ambiguous, ask ONE short clarifying question first; otherwise "
        "go straight to the tool call. The user approves or rejects the change in a "
        "permission prompt, so the tool call IS the confirmation: do not also ask "
        "\"should I schedule this?\" in text. Do not edit the workflow's steps. Keep "
        "every reply to one short sentence."
    )
    config = AgentConfig(
        name=f"Scheduling: {wf.title}",
        model=wf.model or "sonnet",
        mode=wf.mode or "agent",
        provider=wf.provider or "anthropic",
        system_prompt=system_prompt,
        allowed_tools=[],
        dashboard_id=wf.dashboard_id,
    )
    session = await agent_manager.launch_agent(config)
    try:
        setattr(wf, "schedule_agent_session_id", session.id)
        storage.save_workflow(wf)
    except Exception:
        logger.debug("could not persist schedule_agent_session_id (legacy schema)", exc_info=True)
    return {"session_id": session.id}


@workflows.router.post("/{workflow_id}/run")
async def run_workflow_now(workflow_id: str, body: Optional[dict] = None):
    wf = storage.get_workflow(workflow_id)
    if not wf:
        raise HTTPException(status_code=404, detail="Workflow not found")
    # executor.execute() owns the run record. Don't pre-create a stub here
    # or we end up with two rows per manual fire (one orphan "running"
    # row from this handler plus the real one from the executor).
    pre_ids = {r.id for r in storage.list_runs(wf.id, limit=10)}
    tested_signature = body.get("signature") if isinstance(body, dict) else None
    asyncio.create_task(executor.execute(
        wf,
        triggered_by="manual",
        tested_signature=tested_signature if isinstance(tested_signature, str) else None,
    ))

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


def _find_active_run(run_id: str):
    """Locate a currently-running run by id, returning (workflow_id, run)."""
    for wf in storage.list_workflows():
        for r in storage.list_runs(wf.id, limit=50):
            if r.id == run_id and r.status == "running":
                return wf.id, r
    return None, None


async def _broadcast_run(workflow_id: str, run) -> None:
    try:
        from backend.apps.agents.core.ws_manager import ws_manager
        await ws_manager.broadcast_global("workflow:run", {
            "workflow_id": workflow_id,
            "run": run.model_dump(mode="json"),
        })
    except Exception:
        pass


@workflows.router.post("/runs/{run_id}/stop")
async def stop_run(run_id: str):
    """Fully stop a running workflow, failing it with a manual-stop reason.

    Fired by the running card's Stop button. We signal the executor (which
    owns the run's terminal write) and halt the in-flight agent turn now; the
    executor marks the run failure "Stopped by user" and closes the session in
    its finally block. Signalling instead of writing the row here avoids the
    old race where the still-looping executor overwrote the failure.
    """
    target_wf_id, target_run = _find_active_run(run_id)
    if not target_run or not target_wf_id:
        raise HTTPException(status_code=404, detail="Run not found or not active")
    executor.request_stop(run_id)
    if target_run.session_id:
        try:
            from backend.apps.agents.agent_manager import agent_manager
            await agent_manager.stop_agent(target_run.session_id)
        except Exception:
            logger.exception("stop_run: stop_agent failed for %s", target_run.session_id)
    return {"ok": True}


@workflows.router.post("/runs/{run_id}/pause")
async def pause_run(run_id: str):
    """Pause the in-flight agent turn, same mechanic as the chat's Stop.

    The executor holds on the current step (see _await_session_idle) until the
    matching resume. We flag the run paused so the card reflects it even when
    the live chat isn't open.
    """
    target_wf_id, target_run = _find_active_run(run_id)
    if not target_run or not target_wf_id:
        raise HTTPException(status_code=404, detail="Run not found or not active")
    target_run.paused = True
    executor.set_pause_override(run_id, True)
    storage.record_run(target_run)
    await _broadcast_run(target_wf_id, target_run)

    async def _stop_agent_for_pause() -> None:
        if not target_run.session_id:
            return
        try:
            from backend.apps.agents.agent_manager import agent_manager
            await agent_manager.stop_agent(target_run.session_id)
        except Exception:
            logger.exception("pause_run: stop_agent failed for %s", target_run.session_id)
            target_run.paused = False
            executor.set_pause_override(run_id, False, ttl_s=0.1)
            storage.record_run(target_run)
            await _broadcast_run(target_wf_id, target_run)

    asyncio.create_task(_stop_agent_for_pause())
    return {"ok": True, "run": target_run.model_dump(mode="json")}


@workflows.router.post("/runs/{run_id}/resume")
async def resume_run(run_id: str):
    """Resume a paused run, same mechanic as the chat's Resume Agent Response:
    a hidden "continue where you left off" message restarts the current step's
    turn. The executor advances once that turn completes.
    """
    target_wf_id, target_run = _find_active_run(run_id)
    if not target_run or not target_wf_id:
        raise HTTPException(status_code=404, detail="Run not found or not active")
    target_run.paused = False
    executor.set_pause_override(run_id, False)
    storage.record_run(target_run)
    await _broadcast_run(target_wf_id, target_run)

    async def _send_resume_message() -> None:
        if not target_run.session_id:
            return
        try:
            from backend.apps.agents.agent_manager import agent_manager
            await agent_manager.send_message(
                target_run.session_id,
                "Continue where you left off. Start your response EXACTLY with 'Sorry, let me pick up where I left off'",
                hidden=True,
            )
        except Exception:
            logger.exception("resume_run: send_message failed for %s", target_run.session_id)
            target_run.paused = True
            executor.set_pause_override(run_id, True, ttl_s=0.1)
            storage.record_run(target_run)
            await _broadcast_run(target_wf_id, target_run)

    asyncio.create_task(_send_resume_message())
    return {"ok": True, "run": target_run.model_dump(mode="json")}


@workflows.router.get("/{workflow_id}/runs")
async def list_workflow_runs(workflow_id: str, limit: int = 50):
    wf = storage.get_workflow(workflow_id)
    if not wf:
        raise HTTPException(status_code=404, detail="Workflow not found")
    runs = storage.list_runs(workflow_id, limit=limit)
    return {"runs": [r.model_dump(mode="json") for r in runs]}
