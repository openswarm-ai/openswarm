#!/usr/bin/env python3
"""Stdio MCP server exposing BrowserAgent/BrowserAgents delegation tools."""

import base64
import json
import sys
import os
import time
import urllib.request
import urllib.error
from io import BytesIO

try:
    from PIL import Image
    HAS_PIL = True
except ImportError:
    HAS_PIL = False

BACKEND_PORT = os.environ.get("OPENSWARM_PORT", "8324")
BACKEND_AUTH = os.environ.get("OPENSWARM_AUTH_TOKEN", "")
BACKEND_URL = f"http://127.0.0.1:{BACKEND_PORT}/api/browser-agent/run"
MODEL = os.environ.get("OPENSWARM_AGENT_MODEL", "sonnet")
DASHBOARD_ID = os.environ.get("OPENSWARM_DASHBOARD_ID", "")
PRE_SELECTED_BROWSER_IDS = os.environ.get("OPENSWARM_PRE_SELECTED_BROWSER_IDS", "")
PARENT_SESSION_ID = os.environ.get("OPENSWARM_PARENT_SESSION_ID", "")
# Apps the user selected on the dashboard; AppAgent may only target these (anti-hallucination).
SELECTED_APP_IDS = [a.strip() for a in os.environ.get("OPENSWARM_SELECTED_APP_IDS", "").split(",") if a.strip()]

TOOLS = [
    {
        "name": "CreateBrowserAgent",
        "description": (
            "Create a new browser card and run a task on it. A dedicated browser agent "
            "will autonomously perform the task (navigating, clicking, typing, etc.) "
            "and return a summary of actions taken plus a final screenshot. "
            "Use this when you need a fresh browser for a new task."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "task": {
                    "type": "string",
                    "description": (
                        "The task for the browser agent to perform. Be specific and "
                        "detailed about what you want accomplished."
                    ),
                },
                "url": {
                    "type": "string",
                    "description": (
                        "Optional starting URL. The new browser will navigate here "
                        "before beginning the task."
                    ),
                },
            },
            "required": ["task"],
        },
    },
    {
        "name": "BrowserAgent",
        "description": (
            "Delegate a browser task to a dedicated browser agent on an existing "
            "browser card. The browser agent will autonomously perform the task "
            "(navigating, clicking, typing, etc.) and return a summary of actions "
            "taken plus a final screenshot."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "browser_id": {
                    "type": "string",
                    "description": "The ID of the existing browser card to use.",
                },
                "task": {
                    "type": "string",
                    "description": (
                        "The task for the browser agent to perform. Be specific and "
                        "detailed about what you want accomplished."
                    ),
                },
            },
            "required": ["browser_id", "task"],
        },
    },
    {
        "name": "BrowserAgents",
        "description": (
            "Delegate multiple browser tasks to run in parallel, each on an existing "
            "browser card. All tasks execute concurrently and results are returned "
            "together. Use this when you need to perform tasks on multiple web pages "
            "simultaneously."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "tasks": {
                    "type": "array",
                    "description": "Array of browser tasks to run in parallel.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "browser_id": {
                                "type": "string",
                                "description": "The ID of the existing browser card to use.",
                            },
                            "task": {
                                "type": "string",
                                "description": "The task for this browser agent.",
                            },
                        },
                        "required": ["browser_id", "task"],
                    },
                },
            },
            "required": ["tasks"],
        },
    },
    {
        "name": "AppAgent",
        "description": (
            "Operate one of the user's OpenSwarm-built apps (a small web app they "
            "created, e.g. a graphing tool, a form, or a canvas game like Doom) that "
            "is open on the dashboard. A dedicated app agent performs the task: it "
            "drives the app through its native bridge when one is available (reading "
            "the app's own state and calling its controls), and otherwise falls back "
            "to native keyboard/mouse plus screenshots for canvas and game apps that "
            "expose no bridge. It returns a summary plus a final screenshot. Works for "
            "ANY app in the selected-app context, including games and canvas apps; use "
            "BrowserAgent only for websites, not these apps."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "output_id": {
                    "type": "string",
                    "description": (
                        "The id of the selected app to operate (from the selected-app "
                        "context block)."
                    ),
                },
                "task": {
                    "type": "string",
                    "description": (
                        "What to do in the app. Be specific (e.g. 'graph y=x^2 and "
                        "y=sin(x)')."
                    ),
                },
            },
            "required": ["output_id", "task"],
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


def call_backend(tasks: list[dict]) -> dict:
    pre_selected = [bid.strip() for bid in PRE_SELECTED_BROWSER_IDS.split(",") if bid.strip()]
    payload = json.dumps({
        "tasks": tasks,
        "model": MODEL,
        "dashboard_id": DASHBOARD_ID,
        "pre_selected_browser_ids": pre_selected,
        "parent_session_id": PARENT_SESSION_ID,
    }).encode()
    headers = {"Content-Type": "application/json"}
    if BACKEND_AUTH:
        headers["Authorization"] = f"Bearer {BACKEND_AUTH}"
    req = urllib.request.Request(
        BACKEND_URL,
        data=payload,
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode() if e.fp else str(e)
        return {"error": f"HTTP {e.code}: {body}"}
    except Exception as e:
        return {"error": str(e)}


MAX_IMAGE_B64_BYTES = 400_000
MAX_SUMMARY_CHARS = 16_000
MAX_ACTION_LOG_ENTRIES = 40
REPORT_DIR = os.environ.get(
    "OPENSWARM_TOOL_REPORT_DIR",
    os.path.join(os.path.expanduser("~"), ".openswarm", "tool-reports"),
)


def spill_full_report(text: str, prefix: str) -> str:
    """Write the unabridged report to disk so trimming is lossless: the agent can Read
    the file (with offset/limit) whenever the capped version isn't enough. Empty string
    when the write fails; callers degrade to cap-only."""
    try:
        os.makedirs(REPORT_DIR, exist_ok=True)
        # Reports are point-in-time working files, not archives; prune week-old ones so the folder can't grow forever.
        cutoff = time.time() - 7 * 86400
        for old in os.listdir(REPORT_DIR):
            p = os.path.join(REPORT_DIR, old)
            try:
                if os.path.getmtime(p) < cutoff:
                    os.remove(p)
            except OSError:
                pass
        path = os.path.join(REPORT_DIR, f"{prefix}-{os.getpid()}-{int(time.time()*1000)}.md")
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
        return path
    except Exception:
        return ""


def p_cap_summary(text: str) -> tuple[str, bool]:
    """Head+tail split, plus a truncated? flag so the caller can spill the full text: the CLI hard-rejects tool results past ~25K tokens, and a vanished report is worse than a trimmed one."""
    if len(text) <= MAX_SUMMARY_CHARS:
        return text, False
    head = text[: MAX_SUMMARY_CHARS - 4_000]
    tail = text[-3_500:]
    omitted = len(text) - len(head) - len(tail)
    return f"{head}\n\n[... {omitted} chars of the report omitted ...]\n\n{tail}", True


def p_sniff_image_mime(b64: str) -> str:
    """PNG vs JPEG from the base64 magic bytes. Capture now sends JPEG, but older
    callers / cached shots may be PNG, so we label by content, not assumption."""
    if b64.startswith("/9j/"):
        return "image/jpeg"
    if b64.startswith("iVBORw0KGgo"):
        return "image/png"
    return "image/png"


def compress_screenshot(b64_png: str) -> tuple[str, str] | None:
    """Resize and re-encode as JPEG to stay under the stdio buffer limit."""
    if not HAS_PIL:
        return None
    try:
        raw = base64.b64decode(b64_png)
        img = Image.open(BytesIO(raw))
        max_width = 1024
        if img.width > max_width:
            ratio = max_width / img.width
            img = img.resize((max_width, int(img.height * ratio)), Image.LANCZOS)
        buf = BytesIO()
        img.convert("RGB").save(buf, format="JPEG", quality=45)
        return base64.b64encode(buf.getvalue()).decode(), "image/jpeg"
    except Exception:
        return None


def format_result(result: dict) -> dict:
    """Format a single browser agent result into MCP content blocks."""
    if "error" in result:
        return {"content": [{"type": "text", "text": f"Error: {result['error']}"}], "isError": True}

    content = []

    summary = result.get("summary", "Task completed.")
    session_id = result.get("session_id", "")
    browser_id = result.get("browser_id", "")
    action_log = result.get("action_log", [])

    capped_summary, summary_truncated = p_cap_summary(summary)
    lines = [f"**Browser Agent Result** (browser: {browser_id}, session: {session_id})", ""]
    lines.append(f"**Summary:** {capped_summary}")

    actions_omitted = 0
    if action_log:
        lines.append("")
        lines.append("**Actions taken:**")
        entries = action_log[-MAX_ACTION_LOG_ENTRIES:]
        actions_omitted = len(action_log) - len(entries)
        if actions_omitted > 0:
            lines.append(f"  (... {actions_omitted} earlier actions omitted ...)")
        for i, entry in enumerate(entries, actions_omitted + 1):
            tool = entry.get("tool", "?")
            inp = entry.get("input", {})
            ms = entry.get("elapsed_ms", 0)
            brief = json.dumps(inp)[:120]
            lines.append(f"  {i}. {tool}({brief}) [{ms}ms]")

    if summary_truncated or actions_omitted > 0:
        full_lines = [f"# Browser Agent Full Report (browser: {browser_id}, session: {session_id})", "", summary, ""]
        if action_log:
            full_lines.append("## Actions")
            for i, entry in enumerate(action_log, 1):
                full_lines.append(f"{i}. {entry.get('tool', '?')}({json.dumps(entry.get('input', {}))}) [{entry.get('elapsed_ms', 0)}ms]")
        report_path = spill_full_report("\n".join(full_lines), "browser-report")
        if report_path:
            lines.append("")
            lines.append(f"Full unabridged report saved to: {report_path} (use Read with offset/limit for the omitted parts)")

    content.append({"type": "text", "text": "\n".join(lines)})

    screenshot = result.get("final_screenshot")
    if screenshot:
        image_data = screenshot
        mime_type = p_sniff_image_mime(screenshot)

        if len(image_data) > MAX_IMAGE_B64_BYTES:
            compressed = compress_screenshot(image_data)
            if compressed:
                image_data, mime_type = compressed

        if len(image_data) <= MAX_IMAGE_B64_BYTES:
            content.append({"type": "image", "data": image_data, "mimeType": mime_type})
            content.append({"type": "text", "text": "Final screenshot attached above."})
        else:
            content.append({"type": "text", "text": "Final screenshot was too large to include."})

    return {"content": content}


def format_batch_results(results: list[dict]) -> dict:
    """Format multiple browser agent results."""
    if isinstance(results, dict) and "error" in results:
        return {"content": [{"type": "text", "text": f"Error: {results['error']}"}], "isError": True}

    all_content = []
    for i, result in enumerate(results):
        formatted = format_result(result)
        if i > 0:
            all_content.append({"type": "text", "text": f"\n---\n"})
        all_content.extend(formatted.get("content", []))

    return {"content": all_content}


def p_text_error(message: str) -> dict:
    return {"content": [{"type": "text", "text": message}], "isError": True}


def p_run_single_task(task_def: dict) -> dict:
    """Dispatch one task to the backend and format its single result."""
    result = call_backend([task_def])
    if "error" in result:
        return p_text_error(f"Error: {result['error']}")
    results = result.get("results", [result])
    if results:
        return format_result(results[0])
    return p_text_error("No result returned.")


def handle_tool_call(tool_name: str, arguments: dict) -> dict:
    if tool_name == "CreateBrowserAgent":
        return p_run_single_task({
            "task": arguments.get("task", ""),
            "browser_id": "",
            "url": arguments.get("url", ""),
        })

    elif tool_name == "BrowserAgent":
        browser_id = arguments.get("browser_id", "")
        if not browser_id:
            return p_text_error("Error: browser_id is required")
        return p_run_single_task({
            "task": arguments.get("task", ""),
            "browser_id": browser_id,
            "url": "",
        })

    elif tool_name == "AppAgent":
        output_id = arguments.get("output_id", "")
        if not output_id:
            return p_text_error("Error: output_id is required")
        # Only drive apps the user actually selected (anti-hallucination), when we
        # know the selection. Empty list = unknown, so don't block.
        if SELECTED_APP_IDS and output_id not in SELECTED_APP_IDS:
            valid = ", ".join(SELECTED_APP_IDS) or "(none)"
            return p_text_error(f"Error: '{output_id}' is not a selected app. Selected apps: {valid}")
        return p_run_single_task({
            "task": arguments.get("task", ""),
            "browser_id": f"app:{output_id}",
            "url": "",
            "app_mode": True,
        })

    elif tool_name == "BrowserAgents":
        tasks = arguments.get("tasks", [])
        if not tasks:
            return {"content": [{"type": "text", "text": "Error: tasks array is empty"}], "isError": True}
        for t in tasks:
            if not t.get("browser_id"):
                return {"content": [{"type": "text", "text": "Error: browser_id is required for each task"}], "isError": True}
        result = call_backend(tasks)
        if "error" in result:
            return {"content": [{"type": "text", "text": f"Error: {result['error']}"}], "isError": True}
        results = result.get("results", [])
        return format_batch_results(results)

    return {"content": [{"type": "text", "text": f"Unknown tool: {tool_name}"}], "isError": True}


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
                "serverInfo": {
                    "name": "openswarm-browser-agent",
                    "version": "1.0.0",
                },
            })
        elif method == "notifications/initialized":
            pass
        elif method == "tools/list":
            send_response(id_, {"tools": TOOLS})
        elif method == "tools/call":
            tool_name = params.get("name", "")
            arguments = params.get("arguments", {})
            result = handle_tool_call(tool_name, arguments)
            send_response(id_, result)
        elif method == "ping":
            send_response(id_, {})
        elif id_ is not None:
            send_response(id_, error={"code": -32601, "message": f"Method not found: {method}"})


if __name__ == "__main__":
    main()
