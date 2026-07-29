#!/usr/bin/env python3
"""Stdio MCP server exposing scheduled-workflow tools to the agent.

Why this exists: the agent should be able to schedule recurring work on
the user's behalf, but ALWAYS through the native scheduler (visible,
auditable, cost-capped) rather than `crontab`. Each tool is a thin
wrapper around /api/workflows/*. The descriptions are written to prefer
UI-owned workflow conversion for vague recurring asks, and to reserve
ScheduleWorkflow for exact, user-specified live schedules.
"""

import json
import sys
import os
import uuid
import urllib.request
import urllib.error
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

BACKEND_PORT = os.environ.get("OPENSWARM_PORT", "8324")
BACKEND_AUTH = os.environ.get("OPENSWARM_AUTH_TOKEN", "")
BACKEND_BASE = f"http://127.0.0.1:{BACKEND_PORT}/api/workflows"
PARENT_SESSION_ID = os.environ.get("OPENSWARM_PARENT_SESSION_ID", "")
DASHBOARD_ID = os.environ.get("OPENSWARM_DASHBOARD_ID", "")


def p_local_timezone_name() -> str:
    name = os.environ.get("OPENSWARM_TIMEZONE", "").strip()
    if not name:
        try:
            from tzlocal import get_localzone_name  # type: ignore
            name = get_localzone_name() or ""
        except Exception:
            name = ""
    try:
        return (getattr(ZoneInfo(name), "key", None) or "UTC") if name else "UTC"
    except ZoneInfoNotFoundError:
        return "UTC"


PRESETS = {
    "daily_morning": {"enabled": True, "repeat_unit": "day", "repeat_every": 1, "hour": 9, "minute": 0, "on_days": []},
    "weekdays_morning": {"enabled": True, "repeat_unit": "week", "repeat_every": 1, "hour": 9, "minute": 0, "on_days": [1, 2, 3, 4, 5]},
    "weekly_monday": {"enabled": True, "repeat_unit": "week", "repeat_every": 1, "hour": 9, "minute": 0, "on_days": [1]},
    "weekly_friday": {"enabled": True, "repeat_unit": "week", "repeat_every": 1, "hour": 17, "minute": 0, "on_days": [5]},
    "monthly_first": {"enabled": True, "repeat_unit": "month", "repeat_every": 1, "hour": 9, "minute": 0, "day_of_month": 1, "on_days": []},
}


TOOLS = [
    {
        "name": "ScheduleWorkflow",
        "description": (
            "Create a recurring scheduled workflow for the user. Use this "
            "ONLY when the user explicitly asks you to create a live schedule "
            "and has already supplied an exact cadence and time. Do not use "
            "this after a generic convert-to-workflow suggestion, and do not "
            "ask follow-up questions like 'what time should it run' from a "
            "normal chat. If cadence or time is missing, call "
            "SuggestConvertToWorkflow instead so the UI can open the workflow "
            "conversion prompt. "
            "The workflow runs the listed steps on the schedule and is "
            "visible in the user's Workflows hub. Never use crontab, "
            "launchctl, or schtasks to schedule recurring work; always use "
            "this tool so the user can see, pause, edit, or delete it. "
            "After creating, briefly confirm to the user what was scheduled."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "title": {"type": "string", "description": "Short workflow name shown in the hub and on the dashboard card."},
                "steps": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Ordered list of instructions for the agent to execute on each fire. Each string is one step.",
                },
                "preset": {
                    "type": "string",
                    "enum": ["daily_morning", "weekdays_morning", "weekly_monday", "weekly_friday", "monthly_first", "custom"],
                    "description": "Cadence preset. Use 'custom' for anything else, including sub-day cadences like 'every 20 minutes' (repeat_unit='minute') or 'every 3 hours' (repeat_unit='hour').",
                },
                "hour": {"type": "integer", "description": "Hour 0-23 in the user's local time. Required when preset='custom'."},
                "minute": {"type": "integer", "description": "Minute 0/15/30/45. For repeat_unit='hour' this is the minute past the hour; ignored for repeat_unit='minute'. Required when preset='custom'."},
                "repeat_unit": {"type": "string", "enum": ["minute", "hour", "day", "week", "month"], "description": "Required when preset='custom'. 'minute' fires every repeat_every minutes (min 15); 'hour' fires every repeat_every hours."},
                "repeat_every": {"type": "integer", "description": "Interval count for repeat_unit when preset='custom' (e.g. repeat_unit='week' + repeat_every=2 means every other week; repeat_unit='minute' + repeat_every=15 means every 15 minutes). Defaults to 1; minimum 15 when repeat_unit='minute'."},
                "on_days": {
                    "type": "array",
                    "items": {"type": "integer"},
                    "description": "Weekdays (Sun=0..Sat=6) when preset='custom' and repeat_unit='week'.",
                },
                "day_of_month": {"type": "integer", "description": "Day 1-31 when preset='custom' and repeat_unit='month'. Use 1 for 'first of the month'; values past a shorter month's length clamp to that month's last day."},
                "timezone": {"type": "string", "description": "IANA timezone name (e.g. 'America/Los_Angeles'). Omit to use the user's current local zone at scheduling time."},
                "source_session_id": {"type": "string", "description": "Optional; the chat session this workflow was created from. Inherits its tool surface."},
            },
            "required": ["title", "steps", "preset"],
        },
    },
    {
        "name": "ListScheduledWorkflows",
        "description": "List the user's scheduled workflows. Use this to find a workflow the user is referring to before editing or deleting it.",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "UpdateScheduledWorkflow",
        "description": "Modify an existing scheduled workflow. Only pass the fields you want to change. Always confirm with the user via AskUserQuestion before making changes that meaningfully alter behavior (cadence, steps, permissions).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "workflow_id": {"type": "string"},
                "title": {"type": "string"},
                "steps": {"type": "array", "items": {"type": "string"}},
                "schedule_enabled": {"type": "boolean", "description": "Quick on/off without changing other schedule fields."},
                "hour": {"type": "integer", "description": "Hour 0-23 in the schedule's timezone."},
                "minute": {"type": "integer", "description": "Minute 0-59."},
                "repeat_unit": {"type": "string", "enum": ["minute", "hour", "day", "week", "month"]},
                "repeat_every": {"type": "integer", "description": "Interval count for repeat_unit (e.g. 2 with repeat_unit='week' means every other week; 15 with repeat_unit='minute' means every 15 minutes, the minimum)."},
                "on_days": {"type": "array", "items": {"type": "integer"}, "description": "Weekdays (Sun=0..Sat=6) when repeat_unit='week'."},
                "day_of_month": {"type": "integer", "description": "Day 1-31 when repeat_unit='month'. Use 1 for 'first of the month'; values past a shorter month's length clamp to that month's last day."},
                "timezone": {"type": "string", "description": "IANA timezone name (e.g. 'America/Los_Angeles')."},
            },
            "required": ["workflow_id"],
        },
    },
    {
        "name": "DeleteScheduledWorkflow",
        "description": "Permanently delete a scheduled workflow. Cannot be undone. ALWAYS confirm via AskUserQuestion before calling this; the user should pick from a list, not have you guess.",
        "inputSchema": {
            "type": "object",
            "properties": {"workflow_id": {"type": "string"}},
            "required": ["workflow_id"],
        },
    },
    {
        "name": "PauseAllWorkflows",
        "description": "Globally pause every scheduled workflow. In-flight runs finish; future runs are blocked until resumed. Use when the user wants a temporary stop (vacation, debugging) without deleting workflows.",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "ResumeAllWorkflows",
        "description": "Resume scheduled workflows after a previous PauseAllWorkflows.",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "RunWorkflowNow",
        "description": "Trigger an immediate one-off run of a scheduled workflow. The schedule continues to fire on its normal cadence in addition.",
        "inputSchema": {
            "type": "object",
            "properties": {"workflow_id": {"type": "string"}},
            "required": ["workflow_id"],
        },
    },
    {
        "name": "EditWorkflowStep",
        "description": (
            "Edit a single step's prompt text on an existing workflow. Use "
            "when the user has accepted a proposed change during an Edit "
            "Agent conversation; the new prompt replaces the existing one "
            "and persists immediately. The next scheduled run uses the new "
            "version. Always pass new_label too (a fresh 3-5 word summary) "
            "so the workflow card visibly reflects the change instead of "
            "showing the stale old label. Always confirm the change with the "
            "user before calling this; AskUserQuestion FIRST if there is any "
            "ambiguity."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "workflow_id": {"type": "string", "description": "The workflow to edit."},
                "step_idx": {"type": "integer", "description": "0-based index of the step to modify."},
                "new_text": {"type": "string", "description": "Full replacement prompt text for the step."},
                "new_label": {"type": "string", "description": "Fresh 3-5 word at-a-glance label for the card (e.g. 'Greet (Victorian)'). Strongly recommended so the change shows."},
            },
            "required": ["workflow_id", "step_idx", "new_text"],
        },
    },
    {
        "name": "AddWorkflowStep",
        "description": (
            "Add a new step to an existing workflow. Use when the user wants "
            "the workflow to do something more. The step persists immediately "
            "and the next run includes it. Confirm with the user via "
            "AskUserQuestion first if there's any ambiguity about what the "
            "step should do or where it goes."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "workflow_id": {"type": "string", "description": "The workflow to add to."},
                "text": {"type": "string", "description": "Full prompt text for the new step."},
                "label": {"type": "string", "description": "Short 3-5 word at-a-glance label for the card."},
                "position": {"type": "integer", "description": "0-based insert index. Omit to append to the end."},
            },
            "required": ["workflow_id", "text"],
        },
    },
    {
        "name": "DeleteWorkflowStep",
        "description": (
            "Remove a step from an existing workflow. Persists immediately. "
            "A workflow must keep at least one step. ALWAYS confirm via "
            "AskUserQuestion before deleting; the user should pick which step."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "workflow_id": {"type": "string", "description": "The workflow to edit."},
                "step_idx": {"type": "integer", "description": "0-based index of the step to delete."},
            },
            "required": ["workflow_id", "step_idx"],
        },
    },
    {
        "name": "TestWorkflow",
        "description": (
            "Spawn a sibling Test Agent that runs the workflow end-to-end "
            "(the current draft if one is being edited, else the live steps) "
            "so the user can watch it work. Use after editing a step to "
            "verify the change. The Test Agent renders as a sibling card on "
            "the dashboard with a 'Testing' arrow chip linking back to this "
            "workflow. After it finishes, call ReadTestTranscript to see what "
            "it did."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "workflow_id": {"type": "string", "description": "The workflow to test."},
            },
            "required": ["workflow_id"],
        },
    },
    {
        "name": "ReadTestTranscript",
        "description": (
            "Fetch the FULL chat transcript of the most recent Test Agent run "
            "for this workflow: every message, tool call, and result. Call it "
            "after TestWorkflow has finished to read exactly what the test did "
            "and where it succeeded or failed, so you can decide what to change."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "workflow_id": {"type": "string", "description": "The workflow whose latest test run to read."},
            },
            "required": ["workflow_id"],
        },
    },
    {
        "name": "SuggestConvertToWorkflow",
        "description": (
            "Call this at the end of a response when the completed task is a clear "
            "candidate for repeatable scheduled work (e.g. a daily report, weekly "
            "digest, recurring data check, monitoring ping, inbox triage, or status "
            "briefing). Prefer this native workflow nudge over Claude's internal "
            "schedule skill or CronCreate/CronList/CronDelete tools. Use it whenever "
            "the user explicitly mentions daily, weekly, every, each, mornings, "
            "standup, monitoring, alerts, or keeping something updated, and when you "
            "have just done a sequence that would naturally be useful again later. Do "
            "NOT call it for one-off tasks, debugging sessions, creative work, or "
            "anything where 'repeat it tomorrow' would be odd. It is OK to call this "
            "more than once per session for distinct workflow candidates, but avoid "
            "repeated nudges for the same task. This nudges the frontend to highlight "
            "the 'Convert to Workflow' button and open the workflow-conversion "
            "prompt. In user-facing text, say at most one short sentence, such "
            "as: 'This is a good fit for built-in Workflows.' Do not repeat the "
            "advice after this tool returns, do not say you are nudging the UI, "
            "and do not ask what time it should run. After this tool returns, "
            "do not send another assistant message like 'Done'; the UI prompt "
            "will handle the next step."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "reason": {
                    "type": "string",
                    "description": "A brief, user-friendly explanation of why this task is a good candidate for a recurring workflow (e.g. 'This is a daily report that stays the same'). Shown in the tool bubble.",
                },
                "suggested_cadence": {
                    "type": "string",
                    "description": "Optional freeform cadence hint (e.g. 'every weekday morning at 9am' or 'weekly on Monday'). Leave blank if uncertain. The frontend will parse it to prefill the schedule.",
                },
            },
            "required": ["reason"],
        },
    },
    {
        "name": "WatchForEvent",
        "description": (
            "Make a workflow run automatically WHEN SOMETHING HAPPENS (event trigger), as "
            "opposed to ScheduleWorkflow which is for times. Use this whenever the user says "
            "'when/whenever/if X happens, do Y', 'watch/monitor X', or 'alert me when X'. "
            "Pick the kind: 'file' = a local file or folder changes (needs path); "
            "'web' = a specific page's content changes (needs url; watch_for describes the "
            "change that matters, e.g. 'a reservation slot opens'); "
            "'agent' = ANY other condition; an agent checks it on an interval with its tools "
            "(needs check, a plain sentence like 'a new email from my landlord arrived'; if the "
            "check needs a connected account, list the tool names in mcps); "
            "'custom' = an outside system will push events to us (returns the endpoint to call); "
            "'stream' = subscribe to a live Server-Sent Events feed URL (events arrive instantly; "
            "use contains to keep only matching messages). "
            "Attach to an existing workflow by passing workflow (its id or exact title), or pass "
            "title + steps to create a new one (steps are what the agent DOES when it fires). "
            "Use only_when for a plain-English filter ('only if it mentions Friday'). "
            "After creating, briefly confirm what is being watched and what will happen."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "workflow": {"type": "string", "description": "Existing workflow id or exact title to attach the trigger to. Omit when creating a new workflow via title + steps."},
                "title": {"type": "string", "description": "Name for a NEW workflow (when workflow is omitted)."},
                "steps": {"type": "array", "items": {"type": "string"}, "description": "What to do when the event fires, as ordered agent instructions. Required when creating a new workflow."},
                "kind": {"type": "string", "enum": ["file", "web", "agent", "custom", "stream"], "description": "What produces the events."},
                "path": {"type": "string", "description": "kind=file: the file or folder to watch (~ ok)."},
                "url": {"type": "string", "description": "kind=web: the page URL to watch. kind=stream: the SSE feed URL."},
                "contains": {"type": "string", "description": "kind=stream: only messages containing this substring become events."},
                "watch_for": {"type": "string", "description": "kind=web: what change matters, in the user's words."},
                "check": {"type": "string", "description": "kind=agent: the condition to check, one plain sentence."},
                "mcps": {"type": "array", "items": {"type": "string"}, "description": "kind=agent: usually OMIT; the system infers connected tools from the check sentence. Pass only to override the inference."},
                "poll_minutes": {"type": "number", "description": "Usually OMIT: cadence is automatic (tunes itself from observed event rate). Set only when the user asked for a specific frequency; agent checks cost a model call each."},
                "only_when": {"type": "string", "description": "Optional plain-English filter; events not matching it are skipped (logged)."},
                "max_fires_per_hour": {"type": "integer", "description": "Safety cap on runs per hour (default 6)."},
            },
            "required": ["kind"],
        },
    },
    {
        "name": "ListEventTriggers",
        "description": "List every event trigger across the user's workflows (what is being watched, how often, enabled state, ids). Use before removing or editing a trigger, or when the user asks what's being watched.",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "RemoveEventTrigger",
        "description": "Remove one event trigger from a workflow (the workflow itself stays). Confirm with the user first. Use ListEventTriggers to find the trigger_id.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "workflow": {"type": "string", "description": "Workflow id or exact title."},
                "trigger_id": {"type": "string"},
            },
            "required": ["workflow", "trigger_id"],
        },
    },
]


def send_response(id_, result=None, error=None):
    msg = {"jsonrpc": "2.0", "id": id_}
    if error is not None:
        msg["error"] = error
    else:
        msg["result"] = result
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


def _call(method: str, path: str, body=None, timeout: int = 30) -> dict:
    # Absolute paths escape the /api/workflows root (the event tools need /api/tools).
    url = path if path.startswith("http") else BACKEND_BASE + path
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": "application/json"}
    if BACKEND_AUTH:
        headers["Authorization"] = f"Bearer {BACKEND_AUTH}"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode() or "null") or {}
    except urllib.error.HTTPError as e:
        body_err = e.read().decode() if e.fp else str(e)
        return {"_error": f"HTTP {e.code}: {body_err}"}
    except Exception as e:
        return {"_error": str(e)}


def _build_schedule_from_preset(preset: str, args: dict) -> dict:
    local_tz = p_local_timezone_name()
    base = {"timezone": args.get("timezone") or local_tz, "ends_at": None, "max_runs": None, "runs_count": 0}
    if preset == "custom":
        return {
            **base,
            "enabled": True,
            "repeat_unit": args.get("repeat_unit", "day"),
            "repeat_every": int(args.get("repeat_every", 1) or 1),
            "hour": int(args.get("hour", 9)),
            "minute": int(args.get("minute", 0)),
            "on_days": list(args.get("on_days") or []),
            "day_of_month": args.get("day_of_month"),
        }
    preset_def = PRESETS.get(preset)
    if not preset_def:
        return {}
    return {**base, **preset_def, "repeat_every": 1}


def handle_schedule_workflow(args: dict) -> dict:
    title = args.get("title") or "Scheduled workflow"
    steps_in = args.get("steps") or []
    preset = args.get("preset") or "daily_morning"
    schedule = _build_schedule_from_preset(preset, args)
    if not schedule:
        return _err(f"Unknown preset: {preset}. Use one of: {list(PRESETS.keys()) + ['custom']}.")
    body = {
        "title": title,
        "steps": [{"id": f"s{i+1}", "text": s} for i, s in enumerate(steps_in) if s],
        "schedule": schedule,
        "source_session_id": args.get("source_session_id") or PARENT_SESSION_ID or None,
        "dashboard_id": DASHBOARD_ID or None,
    }
    r = _call("POST", "/create", body)
    if "_error" in r:
        return _err(r["_error"])
    wid = r.get("id", "")
    nxt = r.get("next_run_at") or "soon"
    return _ok(f"Scheduled \"{title}\" ({preset}). Workflow id: {wid}. Next run: {nxt}. The user can view, pause, or edit it in the Workflows hub.")


def handle_list(_args: dict) -> dict:
    r = _call("GET", "/list")
    if "_error" in r:
        return _err(r["_error"])
    ws = r.get("workflows", [])
    if not ws:
        return _ok("No scheduled workflows yet.")
    lines = ["Scheduled workflows:"]
    for w in ws:
        s = w.get("schedule") or {}
        enabled = s.get("enabled")
        unit = s.get("repeat_unit", "?")
        hour = s.get("hour")
        title = w.get("title", "(untitled)")
        wid = w.get("id", "")
        state = "ON" if enabled else "off"
        desc = (w.get("description") or "").strip().replace("\n", " ")
        if len(desc) > 120:
            desc = desc[:117] + "..."
        invocable = "  [agent-invocable]" if w.get("exposed_as_tool") else ""
        suffix = f"  - {desc}" if desc else ""
        lines.append(f"  - {title} [{state}] {unit} at {hour:02d}:00  (id: {wid}){invocable}{suffix}")
    return _ok("\n".join(lines))


def handle_update(args: dict) -> dict:
    wid = args.get("workflow_id") or ""
    if not wid:
        return _err("workflow_id is required.")
    cur = _call("GET", f"/{wid}")
    if "_error" in cur:
        return _err(cur["_error"])
    sched = cur.get("schedule") or {}
    patch: dict = {}
    if "title" in args: patch["title"] = args["title"]
    if "steps" in args:
        patch["steps"] = [{"id": f"s{i+1}", "text": s} for i, s in enumerate(args["steps"] or []) if s]
    sched_patch = dict(sched)
    sched_dirty = False
    if "schedule_enabled" in args:
        sched_patch["enabled"] = bool(args["schedule_enabled"])
        sched_dirty = True
    for k in ("hour", "minute", "repeat_unit", "on_days", "repeat_every", "day_of_month", "timezone"):
        if k in args:
            sched_patch[k] = args[k]
            sched_dirty = True
    if sched_dirty:
        patch["schedule"] = sched_patch
    if not patch:
        return _ok(f"No changes requested for workflow {wid}.")
    r = _call("PATCH", f"/{wid}", patch)
    if "_error" in r:
        return _err(r["_error"])
    return _ok(f"Updated \"{r.get('title', wid)}\". Next run: {r.get('next_run_at') or 'paused/unscheduled'}.")


def handle_delete(args: dict) -> dict:
    wid = args.get("workflow_id") or ""
    if not wid:
        return _err("workflow_id is required.")
    r = _call("DELETE", f"/{wid}")
    if "_error" in r:
        return _err(r["_error"])
    return _ok(f"Deleted workflow {wid}.")


def handle_pause_all(_args: dict) -> dict:
    r = _call("POST", "/pause-all")
    if "_error" in r:
        return _err(r["_error"])
    return _ok("All scheduled workflows are paused. In-flight runs will finish; future fires are blocked. Resume with ResumeAllWorkflows.")


def handle_resume_all(_args: dict) -> dict:
    r = _call("POST", "/resume-all")
    if "_error" in r:
        return _err(r["_error"])
    return _ok("Scheduled workflows resumed.")


def handle_run_now(args: dict) -> dict:
    wid = args.get("workflow_id") or ""
    if not wid:
        return _err("workflow_id is required.")
    r = _call("POST", f"/{wid}/run")
    if "_error" in r:
        return _err(r["_error"])
    if r.get("status") == "skipped":
        return _ok(f"Run was skipped: {r.get('error', 'unknown reason')}.")
    return _ok(f"Run started (run id: {r.get('run_id', '')}). Output will appear in the workflow's History.")


def _ok(text: str) -> dict:
    return {"content": [{"type": "text", "text": text}]}


def _err(text: str) -> dict:
    return {"content": [{"type": "text", "text": f"Error: {text}"}], "isError": True}


def handle_edit_step(args: dict) -> dict:
    wid = args.get("workflow_id") or ""
    if not wid:
        return _err("workflow_id is required.")
    try:
        idx = int(args.get("step_idx"))
    except (TypeError, ValueError):
        return _err("step_idx must be an integer.")
    new_text = (args.get("new_text") or "").strip()
    if not new_text:
        return _err("new_text is required.")
    cur = _call("GET", f"/{wid}")
    if "_error" in cur:
        return _err(cur["_error"])
    # Edit against the pending draft when one exists (Edit-Agent flow); else the live steps (main-agent direct edit).
    steps = cur.get("draft_steps") or cur.get("steps") or []
    if idx < 0 or idx >= len(steps):
        return _err(f"step_idx {idx} out of range (workflow has {len(steps)} steps).")
    # Refresh the at-a-glance label so the card reflects the edit; a preserved stale label left the step looking unchanged. Agent-supplied label wins, else clear it so the card falls back to the new text's first words.
    new_label = (args.get("new_label") or "").strip()
    new_steps = list(steps)
    new_steps[idx] = {**new_steps[idx], "text": new_text, "label": new_label}
    r = _call("PATCH", f"/{wid}", {"steps": new_steps})
    if "_error" in r:
        return _err(r["_error"])
    return _ok(f"Step {idx + 1} updated. The next run uses the new prompt.")


def handle_add_step(args: dict) -> dict:
    wid = args.get("workflow_id") or ""
    if not wid:
        return _err("workflow_id is required.")
    text = (args.get("text") or "").strip()
    if not text:
        return _err("text is required.")
    label = (args.get("label") or "").strip()
    cur = _call("GET", f"/{wid}")
    if "_error" in cur:
        return _err(cur["_error"])
    steps = list(cur.get("draft_steps") or cur.get("steps") or [])
    new_step = {"id": "s" + uuid.uuid4().hex[:8], "text": text, "label": label}
    pos = args.get("position")
    if isinstance(pos, int) and 0 <= pos <= len(steps):
        steps.insert(pos, new_step)
    else:
        steps.append(new_step)
    r = _call("PATCH", f"/{wid}", {"steps": steps})
    if "_error" in r:
        return _err(r["_error"])
    return _ok(f"Step added ({len(steps)} total). The next run includes it.")


def handle_delete_step(args: dict) -> dict:
    wid = args.get("workflow_id") or ""
    if not wid:
        return _err("workflow_id is required.")
    try:
        idx = int(args.get("step_idx"))
    except (TypeError, ValueError):
        return _err("step_idx must be an integer.")
    cur = _call("GET", f"/{wid}")
    if "_error" in cur:
        return _err(cur["_error"])
    steps = list(cur.get("draft_steps") or cur.get("steps") or [])
    if idx < 0 or idx >= len(steps):
        return _err(f"step_idx {idx} out of range (workflow has {len(steps)} steps).")
    if len(steps) <= 1:
        return _err("Can't delete the last step; a workflow needs at least one. Edit it instead.")
    steps.pop(idx)
    r = _call("PATCH", f"/{wid}", {"steps": steps})
    if "_error" in r:
        return _err(r["_error"])
    return _ok(f"Step {idx + 1} deleted ({len(steps)} remaining).")


def handle_test_workflow(args: dict) -> dict:
    wid = args.get("workflow_id") or ""
    if not wid:
        return _err("workflow_id is required.")
    r = _call("POST", f"/{wid}/test-run", {})
    if "_error" in r:
        return _err(r["_error"])
    sid = r.get("session_id", "")
    return _ok(f"Test Agent spawned (session {sid[:8]}...). It runs the latest workflow on the dashboard with a Testing arrow chip. Call ReadTestTranscript once it finishes to see what it did.")


def handle_read_test_transcript(args: dict) -> dict:
    wid = args.get("workflow_id") or ""
    if not wid:
        return _err("workflow_id is required.")
    r = _call("GET", f"/{wid}/test-transcript")
    if "_error" in r:
        return _err(r["_error"])
    status = r.get("status")
    if status == "none":
        return _ok("No test has been run yet for this workflow. Call TestWorkflow first.")
    if status == "unavailable":
        return _ok("The most recent test session is no longer available. Run TestWorkflow again.")
    transcript = r.get("transcript") or "(empty transcript)"
    return _ok(f"Test Agent transcript (status: {status}):\n\n{transcript}")


def handle_suggest_convert_to_workflow(args: dict) -> dict:
    reason = (args.get("reason") or "").strip()
    if not reason:
        return _err("reason is required.")
    cadence = (args.get("suggested_cadence") or "").strip()
    result = json.dumps({"reason": reason, "cadence": cadence})
    return {"content": [{"type": "text", "text": result}]}


# Matches the backend's INVOKE_WAIT_TIMEOUT_S; the HTTP call outlives the run wait by a margin.
INVOKE_WAIT_TIMEOUT_S = 15 * 60

TOOLS.append({
    "name": "InvokeWorkflow",
    "description": (
        "Run one of the user's saved workflows and WAIT for its result (status + full transcript). "
        "Only workflows the user marked agent-invocable on the Actions page can be run; "
        "ListScheduledWorkflows marks those with [agent-invocable]. Pass the workflow id or exact title. "
        "Long workflows may take minutes; the call blocks until the run finishes (15 min cap)."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "workflow": {"type": "string", "description": "Workflow id or exact title"},
        },
        "required": ["workflow"],
    },
})


def handle_invoke_workflow(args: dict) -> dict:
    ident = str(args.get("workflow") or "").strip()
    if not ident:
        return _err("workflow (id or exact title) is required")
    r = _call("GET", "/list")
    if "_error" in r:
        return _err(r["_error"])
    exposed = [w for w in r.get("workflows", []) if w.get("exposed_as_tool")]
    match = next((w for w in exposed if w.get("id") == ident), None) or next(
        (w for w in exposed if (w.get("title") or "").strip().lower() == ident.lower()), None)
    if not match:
        names = ", ".join(f"{w.get('title')} (id: {w.get('id')})" for w in exposed) or "(none)"
        return _err(f"No agent-invocable workflow matches '{ident}'. Invocable workflows: {names}")
    res = _call("POST", f"/{match['id']}/invoke", body={}, timeout=INVOKE_WAIT_TIMEOUT_S + 30)
    if "_error" in res:
        return _err(res["_error"])
    if res.get("timed_out"):
        return _ok(f"Run of '{match.get('title')}' is still going after 15 minutes; it continues in the background. Check the workflow's History for the outcome.")
    status = res.get("status") or "unknown"
    err_line = f"\nError: {res.get('error')}" if res.get("error") else ""
    transcript = res.get("transcript") or "(no transcript)"
    return _ok(f"Workflow '{match.get('title')}' run {status}.{err_line}\n\n=== RUN TRANSCRIPT ===\n{transcript}\n=== END TRANSCRIPT ===")


MCP_HINTS = {
    "google-workspace": ("email", "inbox", "gmail", "mail", "calendar", "meeting", "drive", "doc", "sheet"),
    "notion": ("notion", "page", "database"),
    "slack": ("slack", "channel"),
    "discord": ("discord",),
    "reddit": ("reddit", "subreddit"),
    "github": ("github", "pull request", "issue", "repo"),
}


def p_suggest_mcps(check: str, known: set) -> list:
    """Infer connected tools from the check sentence so the user never names them; only suggests tools that actually exist."""
    text = check.lower()
    out = []
    for tool, words in MCP_HINTS.items():
        if tool in known and any(w in text for w in words):
            out.append(tool)
    for tool in known:
        if tool not in out and tool in text:
            out.append(tool)
    return out[:4]


def p_known_tools() -> set:
    r = _call("GET", f"http://127.0.0.1:{BACKEND_PORT}/api/tools/list")
    if "_error" in r:
        return set()
    tools = r.get("tools", r) if isinstance(r, dict) else r
    known = set()
    for t in (tools if isinstance(tools, list) else []):
        for key in ("id", "name"):
            v = str((t or {}).get(key) or "").strip().lower()
            if v:
                known.add(v)
    return known


def p_steps_signature(steps: list) -> str:
    # MUST byte-match the FE stepsSignature (JSON.stringify of [id, text] pairs); pinned by test_watch_for_event_tool.
    return json.dumps([[s["id"], s["text"]] for s in steps], separators=(",", ":"), ensure_ascii=False)


def p_find_workflow_any(ident: str):
    r = _call("GET", "/list")
    if "_error" in r:
        return None, r["_error"]
    ws = r.get("workflows", [])
    match = next((w for w in ws if w.get("id") == ident), None) or next(
        (w for w in ws if (w.get("title") or "").strip().lower() == ident.strip().lower()), None)
    if match is None:
        names = ", ".join(f"{w.get('title')} (id: {w.get('id')})" for w in ws) or "(none)"
        return None, f"No workflow matches '{ident}'. Workflows: {names}"
    return match, None


def p_validate_mcps(mcps: list) -> str:
    """Empty string = fine; otherwise an actionable error naming the valid tools. Fail-open when the list can't be fetched."""
    if not mcps:
        return ""
    r = _call("GET", f"http://127.0.0.1:{BACKEND_PORT}/api/tools/list")
    if "_error" in r:
        return ""
    tools = r.get("tools", r) if isinstance(r, dict) else r
    known = set()
    for t in (tools if isinstance(tools, list) else []):
        for key in ("id", "name"):
            v = str((t or {}).get(key) or "").strip().lower()
            if v:
                known.add(v)
    if not known:
        return ""
    unknown = [m for m in mcps if str(m).strip().lower() not in known]
    if unknown:
        return f"Unknown connected tool(s): {', '.join(unknown)}. Connected tools: {', '.join(sorted(known))}. Fix the mcps list or ask the user to connect the tool first."
    return ""


def p_build_trigger(args: dict) -> tuple:
    """(trigger dict, error string). Kind-specific validation with actionable errors."""
    kind = args.get("kind") or ""
    if kind not in ("file", "web", "agent", "custom", "stream"):
        return None, "kind must be one of: file, web, agent, custom, stream."
    poll_minutes = args.get("poll_minutes")
    # 0 = adaptive: the engine tunes cadence from observed event rate; only an explicit poll_minutes pins it.
    poll_seconds = int(float(poll_minutes) * 60) if poll_minutes else 0
    if kind == "file":
        if not (args.get("path") or "").strip():
            return None, "kind=file needs path (the file or folder to watch)."
        source = {"kind": "file", "path": args["path"].strip(), "poll_seconds": poll_seconds}
    elif kind == "web":
        if not (args.get("url") or "").strip():
            return None, "kind=web needs url (the page to watch)."
        source = {"kind": "web", "url": args["url"].strip(), "watch_for": (args.get("watch_for") or "").strip(), "poll_seconds": poll_seconds}
    elif kind == "agent":
        if not (args.get("check") or "").strip():
            return None, "kind=agent needs check (one sentence describing the condition)."
        mcps = [str(m) for m in (args.get("mcps") or [])]
        if not mcps:
            mcps = p_suggest_mcps(args["check"], p_known_tools())
        mcp_err = p_validate_mcps(mcps)
        if mcp_err:
            return None, mcp_err
        source = {"kind": "agent", "check": args["check"].strip(), "model": "", "mcps": mcps, "poll_seconds": poll_seconds}
    elif kind == "stream":
        if not (args.get("url") or "").strip():
            return None, "kind=stream needs url (the SSE feed to subscribe to)."
        source = {"kind": "stream", "url": args["url"].strip(), "contains": (args.get("contains") or "").strip()}
    else:
        source = {"kind": "custom", "secret": uuid.uuid4().hex}
    return {
        "id": uuid.uuid4().hex,
        "enabled": True,
        "source": source,
        "predicate": (args.get("only_when") or "").strip(),
        "coalesce_seconds": 30 if kind == "file" else 0,
        "max_fires_per_hour": int(args.get("max_fires_per_hour") or 6),
    }, None


def p_describe_trigger(t: dict) -> str:
    s = t.get("source") or {}
    kind = s.get("kind")
    if kind == "file":
        what = f"folder/file {s.get('path')}"
    elif kind == "web":
        what = f"page {s.get('url')}" + (f" (watching for: {s.get('watch_for')})" if s.get("watch_for") else "")
    elif kind == "agent":
        what = f"agent check: {s.get('check')}" + (f" [tools: {', '.join(s.get('mcps') or [])}]" if s.get("mcps") else "")
    elif kind == "stream":
        what = f"live feed {s.get('url')}" + (f" (containing: {s.get('contains')})" if s.get("contains") else "")
    else:
        what = "custom push events"
    state = "ON" if t.get("enabled") else "off"
    cond = f"; only when: {t.get('predicate')}" if t.get("predicate") else ""
    return f"[{state}] {what}{cond} (trigger id: {t.get('id')})"


def handle_watch_for_event(args: dict) -> dict:
    trigger, err = p_build_trigger(args)
    if err:
        return _err(err)
    ident = (args.get("workflow") or "").strip()
    if ident:
        wf, find_err = p_find_workflow_any(ident)
        if find_err:
            return _err(find_err)
        triggers = list(wf.get("event_triggers") or []) + [trigger]
        r = _call("PATCH", f"/{wf['id']}", {"event_triggers": triggers})
        if "_error" in r:
            return _err(r["_error"])
        wid, title = wf["id"], wf.get("title")
    else:
        steps_in = [s for s in (args.get("steps") or []) if str(s).strip()]
        if not steps_in:
            return _err("To create a new workflow, pass title and steps (what to do when the event fires), or pass workflow to attach to an existing one.")
        steps_payload = [{"id": f"s{i+1}", "text": str(s)} for i, s in enumerate(steps_in)]
        body = {
            "title": args.get("title") or "Event workflow",
            "steps": steps_payload,
            "schedule": {"enabled": False},
            "event_triggers": [trigger],
            "source_session_id": PARENT_SESSION_ID or None,
            "dashboard_id": DASHBOARD_ID or None,
            "tested_signature": p_steps_signature(steps_payload),
        }
        r = _call("POST", "/create", body)
        if "_error" in r:
            return _err(r["_error"])
        wid, title = r.get("id", ""), r.get("title")
    extra = ""
    if trigger["source"]["kind"] == "custom":
        extra = (
            f"\nOutside systems push events with ONE URL, no token needed: "
            f"POST http://127.0.0.1:{BACKEND_PORT}/api/events/ingest/{trigger['source']['secret']} "
            f"(JSON body: summary, optional event_type/dedup_key/payload)."
        )
    return _ok(f"Watching. Workflow \"{title}\" (id: {wid}) now runs on {p_describe_trigger(trigger)}.{extra} The user can edit or disable it in the workflow's Event triggers panel.")


def handle_list_event_triggers(_args: dict) -> dict:
    r = _call("GET", "/list")
    if "_error" in r:
        return _err(r["_error"])
    lines = []
    for w in r.get("workflows", []):
        for t in (w.get("event_triggers") or []):
            lines.append(f"  - {w.get('title')} (workflow id: {w.get('id')}): {p_describe_trigger(t)}")
    if not lines:
        return _ok("No event triggers set up yet.")
    return _ok("Event triggers:\n" + "\n".join(lines))


def handle_remove_event_trigger(args: dict) -> dict:
    wf, find_err = p_find_workflow_any((args.get("workflow") or "").strip())
    if find_err:
        return _err(find_err)
    trigger_id = (args.get("trigger_id") or "").strip()
    triggers = list(wf.get("event_triggers") or [])
    kept = [t for t in triggers if t.get("id") != trigger_id]
    if len(kept) == len(triggers):
        ids = ", ".join(t.get("id", "?") for t in triggers) or "(none)"
        return _err(f"No trigger {trigger_id} on '{wf.get('title')}'. Its triggers: {ids}")
    r = _call("PATCH", f"/{wf['id']}", {"event_triggers": kept})
    if "_error" in r:
        return _err(r["_error"])
    return _ok(f"Removed the trigger from \"{wf.get('title')}\". {len(kept)} trigger(s) remain on it.")


HANDLERS = {
    "InvokeWorkflow": handle_invoke_workflow,
    "ScheduleWorkflow": handle_schedule_workflow,
    "ListScheduledWorkflows": handle_list,
    "UpdateScheduledWorkflow": handle_update,
    "DeleteScheduledWorkflow": handle_delete,
    "PauseAllWorkflows": handle_pause_all,
    "ResumeAllWorkflows": handle_resume_all,
    "RunWorkflowNow": handle_run_now,
    "EditWorkflowStep": handle_edit_step,
    "AddWorkflowStep": handle_add_step,
    "DeleteWorkflowStep": handle_delete_step,
    "TestWorkflow": handle_test_workflow,
    "ReadTestTranscript": handle_read_test_transcript,
    "SuggestConvertToWorkflow": handle_suggest_convert_to_workflow,
    "WatchForEvent": handle_watch_for_event,
    "ListEventTriggers": handle_list_event_triggers,
    "RemoveEventTrigger": handle_remove_event_trigger,
}


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        method = msg.get("method")
        id_ = msg.get("id")
        params = msg.get("params", {})
        if method == "initialize":
            send_response(id_, {
                "protocolVersion": "2024-11-05",
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "openswarm-schedule", "version": "1.0.0"},
            })
        elif method == "notifications/initialized":
            pass
        elif method == "tools/list":
            send_response(id_, {"tools": TOOLS})
        elif method == "tools/call":
            tool_name = params.get("name", "")
            arguments = params.get("arguments", {})
            handler = HANDLERS.get(tool_name)
            if handler is None:
                send_response(id_, _err(f"Unknown tool: {tool_name}"))
            else:
                send_response(id_, handler(arguments))
        elif method == "ping":
            send_response(id_, {})
        elif id_ is not None:
            send_response(id_, error={"code": -32601, "message": f"Method not found: {method}"})


if __name__ == "__main__":
    main()
