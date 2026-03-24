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
    """Execute a browser tool. Tries Electron webview first, falls back to headless Playwright."""
    action = ACTION_MAP.get(tool_name)
    if not action:
        return {"error": f"Unknown browser tool: {tool_name}"}

    params = {k: v for k, v in tool_input.items()}
    request_id = uuid4().hex

    # Try Electron webview first
    result = await ws_manager.send_browser_command(
        request_id, action, browser_id, params, tab_id=tab_id,
    )

    # If Electron webview not available, fall back to headless Playwright
    if isinstance(result, dict) and result.get("error") and "not found" in result.get("error", "").lower():
        try:
            from backend.apps.agents.headless_browser import execute as headless_execute
            result = await headless_execute(browser_id, action, params)
        except ImportError:
            return {"error": "Browser not available. Install playwright: pip install playwright && playwright install chromium"}
        except Exception as e:
            return {"error": f"Headless browser error: {e}"}

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

    decision = await ws_manager.send_approval_request(
        session.id, request_id, tool_name, tool_input,
    )

    session.pending_approvals = [
        a for a in session.pending_approvals if a.id != request_id
    ]
    session.status = "running"
    await ws_manager.send_to_session(session.id, "agent:status", {
        "session_id": session.id,
        "status": "running",
    })
    return decision


async def run_browser_agent(
    task: str,
    browser_id: str,
    model: str,
    api_key: str,
    dashboard_id: str | None = None,
    tab_id: str = "",
    pre_selected: bool = False,
    initial_url: str | None = None,
    parent_session_id: str | None = None,
    auth_token: str | None = None,
    base_url: str | None = None,
) -> dict:
    """Run a browser sub-agent loop for a single browser card.

    Creates a visible AgentSession, streams progress via WebSocket,
    and returns the full action log + summary + final screenshot.
    """
    from backend.apps.agents.agent_manager import agent_manager

    _browser_perms = load_builtin_permissions()

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

    api_model = MODEL_MAP.get(model, model)

    # Use OpenAI client for 9Router, Anthropic client for direct API
    _use_openai_client = base_url is not None
    if _use_openai_client:
        from openai import AsyncOpenAI
        # Map to 9Router model IDs
        _9r_map = {"sonnet": "cc/claude-sonnet-4-6", "opus": "cc/claude-opus-4-6", "haiku": "cc/claude-haiku-4-5-20251001"}
        api_model = _9r_map.get(model, f"cc/{api_model}" if not api_model.startswith("cc/") else api_model)
        client = AsyncOpenAI(api_key=api_key, base_url=base_url)
    else:
        client = anthropic.AsyncAnthropic(api_key=api_key)

    messages: list[dict] = [{"role": "user", "content": task}]
    action_log: list[dict] = []
    final_screenshot: str | None = None

    user_msg = Message(role="user", content=task)
    session.messages.append(user_msg)
    await ws_manager.send_to_session(session_id, "agent:message", {
        "session_id": session_id,
        "message": user_msg.model_dump(mode="json"),
    })

    try:
        for turn in range(MAX_TURNS):
            if cancel_event.is_set():
                break

            if _use_openai_client:
                # OpenAI-compatible format (9Router)
                import json as _json
                oai_tools = [{"type": "function", "function": {"name": t["name"], "description": t["description"], "parameters": t["input_schema"]}} for t in BROWSER_TOOLS_SCHEMA]
                oai_messages = [{"role": "system", "content": SYSTEM_PROMPT}] + messages
                resp = await client.chat.completions.create(model=api_model, max_tokens=4096, tools=oai_tools, messages=oai_messages)
                choice = resp.choices[0]

                assistant_content = []
                text_parts = []
                tool_uses = []

                if choice.message.content:
                    text_parts.append(choice.message.content)
                    assistant_content.append({"type": "text", "text": choice.message.content})

                if choice.message.tool_calls:
                    for tc in choice.message.tool_calls:
                        try:
                            inp = _json.loads(tc.function.arguments)
                        except Exception:
                            inp = {}
                        # Create a simple object with .id, .name, .input
                        class _TC:
                            pass
                        tool_obj = _TC()
                        tool_obj.id = tc.id
                        tool_obj.name = tc.function.name
                        tool_obj.input = inp
                        tool_uses.append(tool_obj)
                        assistant_content.append({"type": "tool_use", "id": tc.id, "name": tc.function.name, "input": inp})

                stop_reason = "tool_use" if choice.message.tool_calls else "end_turn"
            else:
                # Anthropic format (direct API)
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
                stop_reason = response.stop_reason

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

            if _use_openai_client:
                # OpenAI format: assistant message with tool_calls
                asst_api_msg: dict = {"role": "assistant", "content": choice.message.content}
                if choice.message.tool_calls:
                    asst_api_msg["tool_calls"] = [{"id": tc.id, "type": "function", "function": {"name": tc.function.name, "arguments": tc.function.arguments}} for tc in (choice.message.tool_calls or [])]
                messages.append(asst_api_msg)
            else:
                messages.append({"role": "assistant", "content": assistant_content})

            if stop_reason != "tool_use":
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

            if _use_openai_client:
                # OpenAI format: each tool result is a separate message
                for tr in tool_results:
                    text_content = ""
                    for block in (tr.get("content") or []):
                        if isinstance(block, dict) and block.get("type") == "text":
                            text_content += block.get("text", "")
                    messages.append({"role": "tool", "tool_call_id": tr["tool_use_id"], "content": text_content or "Done."})
            else:
                messages.append({"role": "user", "content": tool_results})

            if cancelled:
                break

        if cancel_event.is_set():
            session.status = "stopped"
            await ws_manager.send_to_session(session_id, "agent:status", {
                "session_id": session_id,
                "status": "stopped",
            })

        summary_parts = text_parts if text_parts else ["Task completed."]
        summary = "\n".join(summary_parts)

        if not final_screenshot:
            try:
                ss_result = await execute_browser_tool(
                    "BrowserScreenshot", {}, browser_id, tab_id,
                )
                if ss_result.get("image"):
                    final_screenshot = ss_result["image"]
            except Exception:
                pass

        session.status = "completed"
        await ws_manager.send_to_session(session_id, "agent:status", {
            "session_id": session_id,
            "status": "completed",
            "session": session.model_dump(mode="json"),
        })

        await asyncio.sleep(2.5)
        try:
            await agent_manager.close_session(session_id)
        except Exception:
            logger.warning(f"Failed to auto-close browser agent session {session_id}")

        return {
            "session_id": session_id,
            "browser_id": browser_id,
            "summary": summary,
            "action_log": action_log,
            "final_screenshot": final_screenshot,
        }

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

        await asyncio.sleep(2.5)
        try:
            await agent_manager.close_session(session_id)
        except Exception:
            logger.warning(f"Failed to auto-close browser agent session {session_id} after error")

        return {
            "session_id": session_id,
            "browser_id": browser_id,
            "summary": f"Error: {str(e)}",
            "action_log": action_log,
            "final_screenshot": None,
        }


async def _create_browser_card(dashboard_id: str, url: str) -> str:
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
    })
    return browser_id


async def run_browser_agents(
    tasks: list[dict],
    model: str,
    api_key: str,
    dashboard_id: str | None = None,
    pre_selected_browser_ids: list[str] | None = None,
    parent_session_id: str | None = None,
    auth_token: str | None = None,
    base_url: str | None = None,
) -> list[dict]:
    """Run multiple browser sub-agents in parallel.

    Each task dict has: { browser_id (optional), task, url (optional) }
    Returns a list of result dicts, one per task.
    """
    pre_selected = set(pre_selected_browser_ids or [])

    async def _run_one(task_def: dict) -> dict:
        browser_id = task_def.get("browser_id", "")
        task_text = task_def.get("task", "")
        url = task_def.get("url", "")

        if not browser_id and dashboard_id:
            browser_id = await _create_browser_card(dashboard_id, url)
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
            auth_token=auth_token,
            base_url=base_url,
        )

    results = await asyncio.gather(*[_run_one(t) for t in tasks], return_exceptions=True)

    final = []
    for r in results:
        if isinstance(r, Exception):
            final.append({"summary": f"Error: {str(r)}", "action_log": [], "final_screenshot": None})
        else:
            final.append(r)
    return final
