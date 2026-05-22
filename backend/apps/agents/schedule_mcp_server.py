#!/usr/bin/env python3
"""Stdio MCP server exposing scheduled-workflow tools to the agent.

Why this exists: the agent should be able to schedule recurring work on
the user's behalf, but ALWAYS through the native scheduler (visible,
auditable, cost-capped) rather than `crontab`. Each tool is a thin
wrapper around /api/workflows/*. The descriptions are written to nudge
the agent toward AskUserQuestion-first behavior (confirm cadence with
the user before calling ScheduleWorkflow).
"""

import json
import sys
import os
import urllib.request
import urllib.error

BACKEND_PORT = os.environ.get("OPENSWARM_PORT", "8324")
BACKEND_AUTH = os.environ.get("OPENSWARM_AUTH_TOKEN", "")
BACKEND_BASE = f"http://127.0.0.1:{BACKEND_PORT}/api/workflows"
PARENT_SESSION_ID = os.environ.get("OPENSWARM_PARENT_SESSION_ID", "")
DASHBOARD_ID = os.environ.get("OPENSWARM_DASHBOARD_ID", "")


PRESETS = {
    "daily_morning": {"enabled": True, "repeat_unit": "day", "repeat_every": 1, "hour": 9, "minute": 0, "on_days": []},
    "weekdays_morning": {"enabled": True, "repeat_unit": "week", "repeat_every": 1, "hour": 9, "minute": 0, "on_days": [1, 2, 3, 4, 5]},
    "weekly_monday": {"enabled": True, "repeat_unit": "week", "repeat_every": 1, "hour": 9, "minute": 0, "on_days": [1]},
    "weekly_friday": {"enabled": True, "repeat_unit": "week", "repeat_every": 1, "hour": 17, "minute": 0, "on_days": [5]},
    "monthly_first": {"enabled": True, "repeat_unit": "month", "repeat_every": 1, "hour": 9, "minute": 0, "on_days": []},
}


TOOLS = [
    {
        "name": "ScheduleWorkflow",
        "description": (
            "Create a recurring scheduled workflow for the user. Use this "
            "ONLY after confirming cadence with the user via AskUserQuestion "
            "(do not assume — the user must pick or accept the time). "
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
                    "description": "Cadence preset. Use 'custom' to specify your own hour/minute/days.",
                },
                "hour": {"type": "integer", "description": "Hour 0-23 in the user's local time. Required when preset='custom'."},
                "minute": {"type": "integer", "description": "Minute 0/15/30/45. Required when preset='custom'."},
                "repeat_unit": {"type": "string", "enum": ["day", "week", "month"], "description": "Required when preset='custom'."},
                "on_days": {
                    "type": "array",
                    "items": {"type": "integer"},
                    "description": "Weekdays (Sun=0..Sat=6) when preset='custom' and repeat_unit='week'.",
                },
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
                "hour": {"type": "integer"},
                "minute": {"type": "integer"},
                "repeat_unit": {"type": "string", "enum": ["day", "week", "month"]},
                "on_days": {"type": "array", "items": {"type": "integer"}},
            },
            "required": ["workflow_id"],
        },
    },
    {
        "name": "DeleteScheduledWorkflow",
        "description": "Permanently delete a scheduled workflow. Cannot be undone. ALWAYS confirm via AskUserQuestion before calling this — the user should pick from a list, not have you guess.",
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
]


def send_response(id_, result=None, error=None):
    msg = {"jsonrpc": "2.0", "id": id_}
    if error is not None:
        msg["error"] = error
    else:
        msg["result"] = result
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


def _call(method: str, path: str, body=None) -> dict:
    url = BACKEND_BASE + path
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": "application/json"}
    if BACKEND_AUTH:
        headers["Authorization"] = f"Bearer {BACKEND_AUTH}"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode() or "null") or {}
    except urllib.error.HTTPError as e:
        body_err = e.read().decode() if e.fp else str(e)
        return {"_error": f"HTTP {e.code}: {body_err}"}
    except Exception as e:
        return {"_error": str(e)}


def _build_schedule_from_preset(preset: str, args: dict) -> dict:
    base = {"timezone": "local", "on_missed": "skip", "ends_at": None, "max_runs": None, "runs_count": 0}
    if preset == "custom":
        return {
            **base,
            "enabled": True,
            "repeat_unit": args.get("repeat_unit", "day"),
            "repeat_every": 1,
            "hour": int(args.get("hour", 9)),
            "minute": int(args.get("minute", 0)),
            "on_days": list(args.get("on_days") or []),
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
        lines.append(f"  - {title} [{state}] {unit} at {hour:02d}:00  (id: {wid})")
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
    for k in ("hour", "minute", "repeat_unit", "on_days"):
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


HANDLERS = {
    "ScheduleWorkflow": handle_schedule_workflow,
    "ListScheduledWorkflows": handle_list,
    "UpdateScheduledWorkflow": handle_update,
    "DeleteScheduledWorkflow": handle_delete,
    "PauseAllWorkflows": handle_pause_all,
    "ResumeAllWorkflows": handle_resume_all,
    "RunWorkflowNow": handle_run_now,
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
