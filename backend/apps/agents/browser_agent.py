"""
Browser sub-agent runner.

Provides a lightweight Anthropic API tool-use loop that drives browser
interactions directly through ws_manager (no MCP subprocess needed).
Sub-agents appear as visible AgentSession cards on the dashboard.
"""

import asyncio
import json
import logging
import time
from datetime import datetime
from uuid import uuid4

import anthropic

from backend.apps.agents.models import AgentSession, ApprovalRequest, Message
from backend.apps.agents.ws_manager import ws_manager
from backend.apps.tools_lib.tools_lib import load_builtin_permissions

logger = logging.getLogger(__name__)

MODEL_MAP = {
    "sonnet": "claude-sonnet-4-20250514",
    "opus": "claude-opus-4-20250514",
    "opus-1m": "claude-opus-4-6[1m]",
    "haiku": "claude-haiku-4-5-20251001",
}

BROWSER_TOOLS_SCHEMA = [
    {
        "name": "BrowserScreenshot",
        "description": (
            "Capture a screenshot of the browser page. Returns the screenshot as a "
            "base64-encoded PNG image. Use this to see what is currently displayed."
        ),
        "input_schema": {
            "type": "object",
            "properties": {},
            "required": [],
        },
    },
    {
        "name": "BrowserGetText",
        "description": (
            "Get the visible text content of the browser page. Returns up to 15000 characters."
        ),
        "input_schema": {
            "type": "object",
            "properties": {},
            "required": [],
        },
    },
    {
        "name": "BrowserNavigate",
        "description": "Navigate the browser to a URL.",
        "input_schema": {
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "The URL to navigate to."},
            },
            "required": ["url"],
        },
    },
    {
        "name": "BrowserClick",
        "description": "Click an element identified by a CSS selector. Use BrowserGetElements first to discover valid selectors.",
        "input_schema": {
            "type": "object",
            "properties": {
                "selector": {"type": "string", "description": "CSS selector of the element to click."},
            },
            "required": ["selector"],
        },
    },
    {
        "name": "BrowserType",
        "description": "Type text into an input element. Clears existing value first.",
        "input_schema": {
            "type": "object",
            "properties": {
                "selector": {"type": "string", "description": "CSS selector of the input element."},
                "text": {"type": "string", "description": "The text to type."},
            },
            "required": ["selector", "text"],
        },
    },
    {
        "name": "BrowserEvaluate",
        "description": "Evaluate a JavaScript expression in the browser page and return the result.",
        "input_schema": {
            "type": "object",
            "properties": {
                "expression": {"type": "string", "description": "JavaScript expression to evaluate."},
            },
            "required": ["expression"],
        },
    },
    {
        "name": "BrowserGetElements",
        "description": (
            "Get a list of interactive elements on the page with CSS selectors. "
            "Call this BEFORE clicking or typing so you know which selectors are valid."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "selector": {
                    "type": "string",
                    "description": "Optional CSS selector to scope the search (e.g. 'form', '#main'). Defaults to 'body'.",
                },
            },
            "required": [],
        },
    },
    {
        "name": "BrowserScroll",
        "description": (
            "Scroll the page up or down. Automatically finds the correct scrollable "
            "container (works on SPAs like Notion, Gmail, etc. that use nested scroll "
            "containers instead of window-level scrolling). Returns scroll position info "
            "including whether top/bottom has been reached."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "direction": {
                    "type": "string",
                    "enum": ["up", "down"],
                    "description": "Scroll direction. Defaults to 'down'.",
                },
                "amount": {
                    "type": "number",
                    "description": "Pixels to scroll. Defaults to 500.",
                },
            },
            "required": [],
        },
    },
    {
        "name": "BrowserWait",
        "description": (
            "Wait for a specified duration. Useful after navigation or actions that "
            "trigger page loads, animations, or async content rendering. "
            "Min 100ms, max 10000ms."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "milliseconds": {
                    "type": "number",
                    "description": "Duration to wait in milliseconds. Defaults to 1000.",
                },
            },
            "required": [],
        },
    },
]

ACTION_MAP = {
    "BrowserScreenshot": "screenshot",
    "BrowserGetText": "get_text",
    "BrowserNavigate": "navigate",
    "BrowserClick": "click",
    "BrowserType": "type",
    "BrowserEvaluate": "evaluate",
    "BrowserGetElements": "get_elements",
    "BrowserScroll": "scroll",
    "BrowserWait": "wait",
}

SYSTEM_PROMPT = (
    "You are a browser automation agent. You control a single browser tab and "
    "execute the task you are given.\n\n"
    "Strategy:\n"
    "1. Start by taking a screenshot to understand the page.\n"
    "2. After navigation, use BrowserWait (1-3 seconds) to let the page finish loading.\n"
    "3. Use BrowserScroll to scroll through pages — do NOT use BrowserEvaluate with "
    "window.scrollBy() as many sites use nested scroll containers that BrowserScroll "
    "handles automatically.\n"
    "4. Use BrowserGetElements BEFORE clicking or typing to discover valid CSS selectors.\n"
    "5. After performing actions, take a screenshot to verify the result.\n"
    "6. If an action fails, try alternative selectors or approaches.\n"
    "7. When the task is complete, provide a clear summary of what you accomplished.\n\n"
    "Important notes:\n"
    "- BrowserGetText returns up to 15000 chars of visible text — use it to read page content.\n"
    "- BrowserScroll returns position info including atTop/atBottom — use this to know when "
    "you've reached the end of the page.\n"
    "- For complex SPAs (Notion, Gmail, etc.), prefer BrowserScroll over BrowserEvaluate for scrolling.\n"
    "- Avoid looping: if scrolling shows no new content (scrolled 0px), you're at the boundary.\n\n"
    "You have access ONLY to browser tools. Do not ask the user questions — "
    "complete the task autonomously to the best of your ability."
)

MAX_TURNS = 25


async def execute_browser_tool(
    tool_name: str, tool_input: dict, browser_id: str, tab_id: str = "",
) -> dict:
    """Execute a browser tool via ws_manager directly (no MCP/HTTP round-trip)."""
    action = ACTION_MAP.get(tool_name)
    if not action:
        return {"error": f"Unknown browser tool: {tool_name}"}

    params = {k: v for k, v in tool_input.items()}
    request_id = uuid4().hex
    result = await ws_manager.send_browser_command(
        request_id, action, browser_id, params, tab_id=tab_id,
    )
    return result


def _format_tool_result(result: dict, tool_name: str) -> list[dict]:
    """Convert a browser command result dict into Anthropic API content blocks."""
    if "error" in result:
        return [{"type": "text", "text": f"Error: {result['error']}"}]

    if tool_name == "BrowserScreenshot" and result.get("image"):
        blocks = [
            {
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": "image/png",
                    "data": result["image"],
                },
            },
            {"type": "text", "text": f"Screenshot captured. URL: {result.get('url', 'unknown')}"},
        ]
        return blocks

    text = result.get("text", json.dumps(result))
    return [{"type": "text", "text": str(text)}]


async def _request_browser_approval(
    session: AgentSession, tool_name: str, tool_input: dict,
) -> dict:
    """Send an approval request for a browser sub-agent tool and wait for the decision."""
    request_id = uuid4().hex
    approval_req = ApprovalRequest(
        id=request_id,
        session_id=session.id,
        tool_name=tool_name,
        tool_input=tool_input,
    )
    session.pending_approvals.append(approval_req)
    session.status = "waiting_approval"

    await ws_manager.send_to_session(session.id, "agent:status", {
        "session_id": session.id,
        "status": "waiting_approval",
    })

    try:
        decision = await asyncio.wait_for(
            ws_manager.send_approval_request(
                session.id, request_id, tool_name, tool_input,
            ),
            timeout=300.0,
        )
    except asyncio.TimeoutError:
        decision = {"behavior": "deny", "message": "Approval timed out"}

    session.pending_approvals = [
        a for a in session.pending_approvals if a.id != request_id
    ]
    session.status = "running"
    await ws_manager.send_to_session(session.id, "agent:status", {
        "session_id": session.id,
        "status": "running",
    })
    return decision


async def _setup_browser_session(
    task: str,
    browser_id: str,
    model: str,
    dashboard_id: str | None,
    tab_id: str,
    initial_url: str | None,
    parent_session_id: str | None,
) -> tuple:
    """Common setup for browser agent sessions (API and CLI paths)."""
    from backend.apps.agents.agent_manager import agent_manager

    session_id = uuid4().hex
    cancel_event = asyncio.Event()
    session = AgentSession(
        id=session_id,
        name=f"Browser Agent",
        model=model,
        mode="browser-agent",
        status="running",
        dashboard_id=dashboard_id,
        browser_id=browser_id,
        system_prompt=SYSTEM_PROMPT,
        parent_session_id=parent_session_id,
    )
    session._cancel_event = cancel_event
    agent_manager.sessions[session_id] = session

    await ws_manager.send_to_session(session_id, "agent:status", {
        "session_id": session_id,
        "status": "running",
        "session": session.model_dump(mode="json"),
    })

    if initial_url:
        nav_result = await execute_browser_tool(
            "BrowserNavigate", {"url": initial_url}, browser_id, tab_id,
        )
        logger.info(f"Browser agent {session_id}: navigated to {initial_url}: {nav_result.get('text', nav_result.get('error', ''))}")

    user_msg = Message(role="user", content=task)
    session.messages.append(user_msg)
    await ws_manager.send_to_session(session_id, "agent:message", {
        "session_id": session_id,
        "message": user_msg.model_dump(mode="json"),
    })

    return session_id, session, cancel_event


async def _finalize_browser_session(
    session_id: str,
    session: AgentSession,
    browser_id: str,
    tab_id: str,
    summary: str,
    action_log: list[dict],
    final_screenshot: str | None,
    status: str = "completed",
) -> dict:
    """Common finalization for browser agent sessions."""
    if not final_screenshot and status == "completed":
        try:
            ss_result = await execute_browser_tool(
                "BrowserScreenshot", {}, browser_id, tab_id,
            )
            if ss_result.get("image"):
                final_screenshot = ss_result["image"]
        except Exception:
            pass

    session.status = status
    await ws_manager.send_to_session(session_id, "agent:status", {
        "session_id": session_id,
        "status": status,
        "session": session.model_dump(mode="json"),
    })

    return {
        "session_id": session_id,
        "browser_id": browser_id,
        "summary": summary,
        "action_log": action_log,
        "final_screenshot": final_screenshot,
    }


async def _run_browser_agent_api(
    task: str,
    session_id: str,
    session: AgentSession,
    cancel_event: asyncio.Event,
    browser_id: str,
    model: str,
    api_key: str,
    tab_id: str,
) -> dict:
    """Run browser agent using direct Anthropic API (when API key is available)."""
    _browser_perms = load_builtin_permissions()
    api_model = MODEL_MAP.get(model, model)
    client = anthropic.AsyncAnthropic(api_key=api_key)

    messages: list[dict] = [{"role": "user", "content": task}]
    action_log: list[dict] = []
    final_screenshot: str | None = None

    for turn in range(MAX_TURNS):
        if cancel_event.is_set():
            break

        response = await client.messages.create(
            model=api_model,
            max_tokens=4096,
            system=SYSTEM_PROMPT,
            tools=BROWSER_TOOLS_SCHEMA,
            messages=messages,
        )

        assistant_content = []
        text_parts = []
        tool_uses = []

        for block in response.content:
            if block.type == "text":
                text_parts.append(block.text)
                assistant_content.append({"type": "text", "text": block.text})
            elif block.type == "tool_use":
                tool_uses.append(block)
                assistant_content.append({
                    "type": "tool_use",
                    "id": block.id,
                    "name": block.name,
                    "input": block.input,
                })

        if text_parts:
            asst_msg = Message(
                role="assistant",
                content="\n".join(text_parts),
            )
            session.messages.append(asst_msg)
            await ws_manager.send_to_session(session_id, "agent:message", {
                "session_id": session_id,
                "message": asst_msg.model_dump(mode="json"),
            })

        for tu in tool_uses:
            tool_msg = Message(
                role="tool_call",
                content={"id": tu.id, "tool": tu.name, "input": tu.input},
            )
            session.messages.append(tool_msg)
            await ws_manager.send_to_session(session_id, "agent:message", {
                "session_id": session_id,
                "message": tool_msg.model_dump(mode="json"),
            })

        messages.append({"role": "assistant", "content": assistant_content})

        if response.stop_reason != "tool_use":
            break

        tool_results = []
        cancelled = False
        for tu in tool_uses:
            if cancel_event.is_set():
                cancelled = True
                break

            policy = _browser_perms.get(tu.name, "always_allow")

            if policy == "deny":
                denied_text = f"Tool {tu.name} is denied by permission policy."
                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": tu.id,
                    "content": [{"type": "text", "text": denied_text}],
                })
                result_msg = Message(
                    role="tool_result",
                    content={"text": denied_text, "tool_name": tu.name, "elapsed_ms": 0},
                )
                session.messages.append(result_msg)
                await ws_manager.send_to_session(session_id, "agent:message", {
                    "session_id": session_id,
                    "message": result_msg.model_dump(mode="json"),
                })
                continue

            if policy == "ask":
                decision = await _request_browser_approval(
                    session, tu.name, tu.input,
                )
                if decision.get("behavior") == "deny":
                    denied_text = decision.get("message") or f"Tool {tu.name} denied by user."
                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": tu.id,
                        "content": [{"type": "text", "text": denied_text}],
                    })
                    result_msg = Message(
                        role="tool_result",
                        content={"text": denied_text, "tool_name": tu.name, "elapsed_ms": 0},
                    )
                    session.messages.append(result_msg)
                    await ws_manager.send_to_session(session_id, "agent:message", {
                        "session_id": session_id,
                        "message": result_msg.model_dump(mode="json"),
                    })
                    continue

            start = time.time()
            result = await execute_browser_tool(
                tu.name, tu.input, browser_id, tab_id,
            )
            elapsed_ms = int((time.time() - start) * 1000)

            action_log.append({
                "tool": tu.name,
                "input": tu.input,
                "result_summary": result.get("text", result.get("error", ""))[:200],
                "elapsed_ms": elapsed_ms,
            })

            if tu.name == "BrowserScreenshot" and result.get("image"):
                final_screenshot = result["image"]

            content_blocks = _format_tool_result(result, tu.name)
            tool_results.append({
                "type": "tool_result",
                "tool_use_id": tu.id,
                "content": content_blocks,
            })

            result_text = result.get("text", result.get("error", ""))
            result_msg = Message(
                role="tool_result",
                content={"text": result_text, "tool_name": tu.name, "elapsed_ms": elapsed_ms},
            )
            session.messages.append(result_msg)
            await ws_manager.send_to_session(session_id, "agent:message", {
                "session_id": session_id,
                "message": result_msg.model_dump(mode="json"),
            })

        messages.append({"role": "user", "content": tool_results})

        if cancelled:
            break

    if cancel_event.is_set():
        return await _finalize_browser_session(
            session_id, session, browser_id, tab_id,
            "Agent was stopped.", action_log, final_screenshot, "stopped",
        )

    summary = "\n".join(text_parts) if text_parts else "Task completed."
    return await _finalize_browser_session(
        session_id, session, browser_id, tab_id,
        summary, action_log, final_screenshot,
    )


async def _run_browser_agent_cli(
    task: str,
    session_id: str,
    session: AgentSession,
    cancel_event: asyncio.Event,
    browser_id: str,
    model: str,
    tab_id: str,
) -> dict:
    """Run browser agent using Claude Code CLI (when no API key is available)."""
    import os as _os
    import sys as _sys
    from claude_agent_sdk import query, ClaudeAgentOptions
    from claude_agent_sdk.types import AssistantMessage, ResultMessage, TextBlock, ToolUseBlock

    action_log: list[dict] = []
    final_screenshot: str | None = None
    text_parts: list[str] = []

    browser_tools_server = _os.path.join(
        _os.path.dirname(__file__), "browser_tools_mcp_server.py",
    )
    backend_port = _os.environ.get("OPENSWARM_PORT", "8324")

    options = ClaudeAgentOptions(
        model=model,
        system_prompt=SYSTEM_PROMPT,
        max_turns=MAX_TURNS,
        permission_mode="bypassPermissions",
        mcp_servers={
            "browser-tools": {
                "command": _sys.executable,
                "args": [browser_tools_server],
                "env": {
                    "OPENSWARM_PORT": backend_port,
                    "OPENSWARM_BROWSER_ID": browser_id,
                },
                "type": "stdio",
            },
        },
        stderr=lambda line: None,
    )

    async for message in query(prompt=task, options=options):
        if cancel_event.is_set():
            break

        if isinstance(message, AssistantMessage):
            for block in message.content:
                if isinstance(block, TextBlock):
                    text_parts.append(block.text)
                    asst_msg = Message(role="assistant", content=block.text)
                    session.messages.append(asst_msg)
                    await ws_manager.send_to_session(session_id, "agent:message", {
                        "session_id": session_id,
                        "message": asst_msg.model_dump(mode="json"),
                    })
                elif isinstance(block, ToolUseBlock):
                    tool_name = block.name
                    # Strip MCP prefix if present (e.g. mcp__browser-tools__BrowserClick → BrowserClick)
                    if "__" in tool_name:
                        tool_name = tool_name.split("__")[-1]

                    tool_msg = Message(
                        role="tool_call",
                        content={"id": block.id, "tool": tool_name, "input": block.input},
                    )
                    session.messages.append(tool_msg)
                    await ws_manager.send_to_session(session_id, "agent:message", {
                        "session_id": session_id,
                        "message": tool_msg.model_dump(mode="json"),
                    })

                    action_log.append({
                        "tool": tool_name,
                        "input": block.input,
                        "result_summary": "",
                        "elapsed_ms": 0,
                    })

    if cancel_event.is_set():
        return await _finalize_browser_session(
            session_id, session, browser_id, tab_id,
            "Agent was stopped.", action_log, final_screenshot, "stopped",
        )

    summary = "\n".join(text_parts) if text_parts else "Task completed."
    return await _finalize_browser_session(
        session_id, session, browser_id, tab_id,
        summary, action_log, final_screenshot,
    )


async def run_browser_agent(
    task: str,
    browser_id: str,
    model: str,
    api_key: str | None = None,
    dashboard_id: str | None = None,
    tab_id: str = "",
    pre_selected: bool = False,
    initial_url: str | None = None,
    parent_session_id: str | None = None,
) -> dict:
    """Run a browser sub-agent loop for a single browser card.

    Creates a visible AgentSession, streams progress via WebSocket,
    and returns the full action log + summary + final screenshot.

    Routes through direct Anthropic API when api_key is provided,
    or through Claude Code CLI when it's not.
    """
    session_id, session, cancel_event = await _setup_browser_session(
        task, browser_id, model, dashboard_id, tab_id, initial_url, parent_session_id,
    )

    try:
        if api_key:
            return await _run_browser_agent_api(
                task, session_id, session, cancel_event,
                browser_id, model, api_key, tab_id,
            )
        else:
            return await _run_browser_agent_cli(
                task, session_id, session, cancel_event,
                browser_id, model, tab_id,
            )
    except Exception as e:
        logger.exception(f"Browser agent {session_id} error: {e}")
        session.status = "error"
        error_msg = Message(role="system", content=f"Error: {str(e)}")
        session.messages.append(error_msg)
        await ws_manager.send_to_session(session_id, "agent:message", {
            "session_id": session_id,
            "message": error_msg.model_dump(mode="json"),
        })
        await ws_manager.send_to_session(session_id, "agent:status", {
            "session_id": session_id,
            "status": "error",
            "session": session.model_dump(mode="json"),
        })

        return {
            "session_id": session_id,
            "browser_id": browser_id,
            "summary": f"Error: {str(e)}",
            "action_log": [],
            "final_screenshot": None,
        }


async def _create_browser_card(dashboard_id: str, url: str, parent_session_id: str | None = None) -> str:
    """Create a new browser card on the dashboard and return its browser_id."""
    from backend.apps.dashboards.dashboards import _load, _save
    from backend.apps.dashboards.models import BrowserCardPosition, BrowserTab

    dashboard = _load(dashboard_id)
    browser_id = f"browser-{uuid4().hex[:8]}"
    tab_id = f"tab-{uuid4().hex[:8]}"
    tab = BrowserTab(id=tab_id, url=url or "https://www.google.com", title="")
    card = BrowserCardPosition(
        browser_id=browser_id,
        url=url or "https://www.google.com",
        tabs=[tab],
        activeTabId=tab_id,
        x=40,
        y=100,
        width=1280,
        height=800,
    )
    dashboard.layout.browser_cards[browser_id] = card
    dashboard.updated_at = datetime.now()
    _save(dashboard)

    await ws_manager.broadcast_global("dashboard:browser_card_added", {
        "dashboard_id": dashboard_id,
        "browser_card": card.model_dump(mode="json"),
        "parent_session_id": parent_session_id or "",
    })
    return browser_id


async def run_browser_agents(
    tasks: list[dict],
    model: str,
    api_key: str | None = None,
    dashboard_id: str | None = None,
    pre_selected_browser_ids: list[str] | None = None,
    parent_session_id: str | None = None,
) -> list[dict]:
    """Run multiple browser sub-agents in parallel.

    Each task dict has: { browser_id (optional), task, url (optional) }
    Returns a list of result dicts, one per task.
    Uses direct API when api_key is provided, CLI otherwise.
    """
    pre_selected = set(pre_selected_browser_ids or [])

    async def _run_one(task_def: dict) -> dict:
        browser_id = task_def.get("browser_id", "")
        task_text = task_def.get("task", "")
        url = task_def.get("url", "")

        if not browser_id and dashboard_id:
            browser_id = await _create_browser_card(dashboard_id, url, parent_session_id)
            await asyncio.sleep(2.0)

        is_pre_selected = browser_id in pre_selected
        return await run_browser_agent(
            task=task_text,
            browser_id=browser_id,
            model=model,
            api_key=api_key,
            dashboard_id=dashboard_id,
            pre_selected=is_pre_selected,
            initial_url=url if url and browser_id not in pre_selected else None,
            parent_session_id=parent_session_id,
        )

    results = await asyncio.gather(*[_run_one(t) for t in tasks], return_exceptions=True)

    final = []
    for r in results:
        if isinstance(r, Exception):
            final.append({"summary": f"Error: {str(r)}", "action_log": [], "final_screenshot": None})
        else:
            final.append(r)
    return final
