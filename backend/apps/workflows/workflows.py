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
    # Force-generate title + description + per-step labels from the steps
    # in a single aux call. Previously we only filled missing description,
    # leaving stale session names ("Inbox check") as titles. Step labels
    # are the 3-6 word at-a-glance headlines surfaced in StepList; without
    # them the UI falls back to truncated raw prompts.
    try:
        title, description, labels = await _generate_workflow_metadata(wf)
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
    return _enriched(wf)


async def _generate_workflow_metadata(wf: Workflow) -> tuple[str, str, list[str]]:
    """Single aux-model call returning (title, description, step_labels).

    One round-trip for all three so we don't burn 3x aux cost. Returns
    ("", "", []) on any failure; caller writes back unconditionally.
    """
    if not wf.steps:
        return "", "", []
    try:
        from backend.apps.agents.providers.registry import resolve_aux_model
        from backend.apps.settings.credentials import get_anthropic_client_for_model
        from backend.apps.settings.settings import load_settings as _ls
    except Exception:
        return "", "", []
    settings = _ls()
    try:
        aux_model, _ = await resolve_aux_model(settings, preferred_tier="haiku")
        client = get_anthropic_client_for_model(settings, aux_model)
    except Exception:
        return "", "", []
    steps_lines = "\n".join(f"{i+1}. {s.text}" for i, s in enumerate(wf.steps) if s.text)
    n_steps = len(wf.steps)
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
        resp = await client.messages.create(
            model=aux_model,
            max_tokens=400 + n_steps * 30,
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


async def p_relabel_changed_steps(wf: Workflow, before_steps: list[dict]) -> None:
    before_by_id = {s.get("id"): s for s in before_steps}
    regen_idxs: list[int] = []
    for i, step in enumerate(wf.steps):
        old = before_by_id.get(step.id)
        old_text = (old or {}).get("text") or ""
        old_label = (old or {}).get("label") or ""
        new_label = (step.label or "").strip()
        if old is not None and old_text == step.text:
            if not new_label and old_label:
                step.label = old_label
            continue
        if not (new_label and new_label != old_label):
            regen_idxs.append(i)
    if not regen_idxs:
        return
    try:
        labels = (await _generate_workflow_metadata(wf))[2]
    except Exception:
        return
    if labels and len(labels) == len(wf.steps):
        for i in regen_idxs:
            if labels[i]:
                wf.steps[i].label = labels[i]


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
    if "steps" in data:
        await p_relabel_changed_steps(wf, before.get("steps") or [])
    wf.updated_at = datetime.now()
    if not wf.icon:
        wf.icon = _derive_icon(wf)
    wf.next_run_at = scheduler.compute_next_fire(wf) if wf.schedule.enabled else None
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
    existed = storage.delete_workflow(workflow_id)
    if not existed:
        raise HTTPException(status_code=404, detail="Workflow not found")
    scheduler.kick()
    try:
        from backend.apps.agents.core.ws_manager import ws_manager
        await ws_manager.broadcast_global("workflow:deleted", {"workflow_id": workflow_id})
    except Exception:
        pass
    return {"ok": True}


@workflows.router.post("/{workflow_id}/propose-edit")
async def propose_edit(workflow_id: str, body: dict):
    """Aux-LLM-propose a single-step edit from a natural-language request.

    Powers the Edit Agent chat (Image #38). Frontend hands us the user's
    message, the current draft steps, optional failure-context (Fix-with-
    Agent), AND the prior turns so the model has multi-turn memory. We
    respond with a reply string PLUS, optionally, a `step_idx` + `new_text`
    that the FE shows as a proposal card.
    """
    wf = storage.get_workflow(workflow_id)
    if not wf:
        raise HTTPException(status_code=404, detail="Workflow not found")
    message = (body or {}).get("message", "").strip()
    steps_in = (body or {}).get("steps") or []
    context = (body or {}).get("context") or None
    history = (body or {}).get("history") or []
    if not message or not isinstance(steps_in, list):
        raise HTTPException(status_code=400, detail="Missing message or steps")
    try:
        from backend.apps.agents.providers.registry import resolve_aux_model
        from backend.apps.settings.credentials import get_anthropic_client_for_model
        from backend.apps.settings.settings import load_settings as _ls
    except Exception:
        raise HTTPException(status_code=500, detail="Aux model unavailable")
    settings = _ls()
    try:
        aux_model, _ = await resolve_aux_model(settings, preferred_tier="haiku")
        client = get_anthropic_client_for_model(settings, aux_model)
    except Exception:
        raise HTTPException(status_code=500, detail="Aux model unavailable")
    import json, re
    steps_lines = "\n".join(
        f"{i+1}. {(s.get('label') or '').strip() or (s.get('text') or '')[:60]}: {(s.get('text') or '')}"
        for i, s in enumerate(steps_in)
    )
    fix_context = ""
    if context and isinstance(context, dict):
        fs = context.get("failed_step")
        err = context.get("error")
        if fs is not None and err:
            fix_context = (
                f"\n\nFAILURE CONTEXT: Step {int(fs) + 1} failed on the most recent run. "
                f"The error was: {err}\n"
                f"Your proposed edit should specifically address that failure if possible."
            )
    # Build history block so the model remembers prior turns. Each entry
    # is {role, text}; we only carry assistant/user pairs (proposals get
    # summarised inline so the assistant has context for follow-ups).
    history_lines = []
    if isinstance(history, list):
        for h in history[-12:]:
            if not isinstance(h, dict):
                continue
            role = str(h.get("role") or "").strip().lower()
            text = str(h.get("text") or "").strip()
            if role in ("user", "assistant") and text:
                history_lines.append(f"{role.capitalize()}: {text}")
    history_block = ("\n\nPrior conversation:\n" + "\n".join(history_lines)) if history_lines else ""

    prompt = (
        "You are an Edit Agent helping the user iterate on a saved automation "
        "workflow. The workflow's current steps are listed below. The user has "
        "asked for a modification.\n\n"
        "Respond with STRICT JSON, no prose, no fence. Schema:\n"
        '  {"reply": string, '
        '"step_idx": int | null, '
        '"new_text": string | null, '
        '"explanation": string | null}\n\n'
        "Rules:\n"
        "- `reply` is a short conversational acknowledgement (1-2 sentences).\n"
        "- If the user is asking a question or for clarification, set step_idx=null and new_text=null.\n"
        "- If the user is asking to change a specific step, set step_idx (0-based) and new_text to the FULL replacement prompt for that step.\n"
        "- `explanation` describes the change in user-facing terms.\n"
        "- Never invent new steps. Never remove steps. Only edit existing ones.\n"
        "- Use prior conversation context to disambiguate follow-ups (e.g. \"yes do that\" should reference the last proposal).\n\n"
        f"Workflow steps:\n{steps_lines}{fix_context}{history_block}\n\n"
        f"User: {message}"
    )
    try:
        resp = await client.messages.create(
            model=aux_model,
            max_tokens=400,
            messages=[
                {"role": "user", "content": prompt},
                {"role": "assistant", "content": "{"},
            ],
        )
        out = ""
        if isinstance(resp.content, list):
            for block in resp.content:
                if getattr(block, "type", None) == "text":
                    out += getattr(block, "text", "")
        raw = "{" + out.strip() if not out.strip().startswith("{") else out.strip()
        m = re.search(r"\{.*\}", raw, flags=re.DOTALL)
        if m:
            raw = m.group(0)
        data = json.loads(raw)
    except Exception as e:
        logger.warning("propose-edit: aux LLM failed: %s", e)
        raise HTTPException(status_code=400, detail="Couldn't generate a proposal")
    reply = str(data.get("reply") or "").strip()[:600]
    step_idx = data.get("step_idx")
    new_text = data.get("new_text")
    explanation = str(data.get("explanation") or "").strip()[:600]
    out: dict = {"reply": reply}
    if isinstance(step_idx, int) and 0 <= step_idx < len(steps_in) and isinstance(new_text, str) and new_text.strip():
        out["step_idx"] = step_idx
        out["new_text"] = new_text.strip()
        if explanation:
            out["explanation"] = explanation
    return out


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
    # Track the edit-agent session id on the workflow record so the FE
    # can find it after a reload. Persisted under a private namespace
    # field added below; we attach it lazily so existing workflows don't
    # need a migration.
    existing_id = getattr(wf, "edit_agent_session_id", None) or None
    if existing_id:
        from backend.apps.agents.agent_manager import agent_manager
        if existing_id in agent_manager.sessions:
            return {"session_id": existing_id}
        # In-memory miss but on disk it's still valid; fall through to
        # rehydrate via launch_agent OR return id for the FE to fetch.
        return {"session_id": existing_id}

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
        "3. To change the workflow's steps, call the matching tool; each "
        "persists immediately and refreshes the user's card live:\n"
        "   - EditWorkflowStep(workflow_id, step_idx, new_text, new_label) to "
        "rewrite a step. ALWAYS pass new_label (a fresh 3-5 word summary) so "
        "the card reflects the change instead of the stale old label.\n"
        "   - AddWorkflowStep(workflow_id, text, label) to add a step.\n"
        "   - DeleteWorkflowStep(workflow_id, step_idx) to remove one.\n"
        "   Confirm via AskUserQuestion FIRST if there's any ambiguity.\n"
        "4. Call TestWorkflow(workflow_id) to spawn a sibling Test Agent that "
        "runs the latest version end-to-end. Use this after a change to verify "
        "it works.\n\n"
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
    try:
        setattr(wf, "edit_agent_session_id", session.id)
        storage.save_workflow(wf)
    except Exception:
        logger.debug("could not persist edit_agent_session_id (legacy schema)", exc_info=True)
    return {"session_id": session.id}


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
    draft_steps = (body or {}).get("steps")
    steps_texts: list[str]
    if isinstance(draft_steps, list) and draft_steps:
        steps_texts = [str(s.get("text") or "") for s in draft_steps if isinstance(s, dict) and s.get("text")]
    else:
        steps_texts = [s.text for s in wf.steps if s.text and s.text.strip()]
    if not steps_texts:
        raise HTTPException(status_code=400, detail="Workflow has no steps to test")

    from backend.apps.agents.core.models import AgentConfig
    from backend.apps.agents.agent_manager import agent_manager
    from backend.apps.workflows import executor

    config = AgentConfig(
        name=f"{wf.title or 'Workflow'} (test)",
        model=wf.model or "sonnet",
        mode=wf.mode or "agent",
        provider=wf.provider or "anthropic",
        system_prompt=executor._resolve_system_prompt(wf),
        allowed_tools=executor._resolve_allowed_tools(wf) or [
            "Read", "Edit", "Write", "Bash", "Glob", "Grep", "AskUserQuestion",
        ],
        dashboard_id=wf.dashboard_id,
    )
    session = await agent_manager.launch_agent(config)

    async def _drive_test() -> None:
        try:
            for step in steps_texts:
                await agent_manager.send_message(session.id, step)
                await executor._await_session_idle(session.id)
                sess_state = agent_manager.sessions.get(session.id)
                if sess_state is not None and getattr(sess_state, "status", None) == "error":
                    return
        except Exception:
            logger.exception("test-run drive loop failed")
    asyncio.create_task(_drive_test())

    return {"session_id": session.id}


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
    current_dt = now_local.strftime("%A %Y-%m-%d %H:%M %Z")
    system_prompt = (
        f"You are the Scheduling Agent for the user's saved workflow \"{wf.title}\" "
        f"(id: {wf.id}). Your only job is to set when this workflow runs.\n\n"
        f"The current local date and time is {current_dt}. Resolve relative "
        "phrasing (\"this month\", \"next Wednesday\", \"this time\") against it.\n\n"
        "When the user states a cadence, interpret it yourself and call "
        "UpdateScheduledWorkflow with:\n"
        f"  - workflow_id: \"{wf.id}\"\n"
        "  - schedule_enabled: true\n"
        "  - hour (0-23) and minute (0-59) in the user's local time\n"
        "  - repeat_unit: \"day\" | \"week\" | \"month\"\n"
        "  - repeat_every: the interval count (1 unless they say e.g. \"every other\")\n"
        "  - on_days: weekday indices when repeat_unit=\"week\" (Sun=0, Mon=1, ... Sat=6)\n"
        "  - timezone: an IANA name only if the user names a specific zone\n\n"
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


@workflows.router.post("/runs/{run_id}/stop")
async def stop_run(run_id: str):
    """Force-terminate a running workflow's underlying agent session.

    Fired by RunningView's Stop button (Image #40). The run record gets
    marked failure with a "stopped by user" error so it surfaces correctly
    in History instead of looking like it succeeded.
    """
    target_wf_id = None
    target_run = None
    for wf in storage.list_workflows():
        for r in storage.list_runs(wf.id, limit=50):
            if r.id == run_id and r.status == "running":
                target_wf_id = wf.id
                target_run = r
                break
        if target_run:
            break
    if not target_run or not target_wf_id:
        raise HTTPException(status_code=404, detail="Run not found or not active")
    if target_run.session_id:
        try:
            from backend.apps.agents.agent_manager import agent_manager
            await agent_manager.close_session(target_run.session_id)
        except Exception:
            logger.exception("stop_run: close_session failed for %s", target_run.session_id)
    target_run.status = "failure"
    target_run.error = "Stopped by user"
    target_run.finished_at = datetime.now()
    storage.record_run(target_run)
    wf = storage.get_workflow(target_wf_id)
    if wf:
        _persist_run_fields(wf, {
            "last_run_status": "failure",
            "last_run_at": target_run.finished_at,
            "last_run_id": target_run.id,
        })
    try:
        from backend.apps.agents.core.ws_manager import ws_manager
        await ws_manager.broadcast_global("workflow:run", {
            "workflow_id": target_wf_id,
            "run": target_run.model_dump(mode="json"),
        })
    except Exception:
        pass
    return {"ok": True}


@workflows.router.get("/{workflow_id}/runs")
async def list_workflow_runs(workflow_id: str, limit: int = 50):
    wf = storage.get_workflow(workflow_id)
    if not wf:
        raise HTTPException(status_code=404, detail="Workflow not found")
    runs = storage.list_runs(workflow_id, limit=limit)
    return {"runs": [r.model_dump(mode="json") for r in runs]}
