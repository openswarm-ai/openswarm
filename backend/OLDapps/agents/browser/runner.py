"""Browser agent runner — run_browser_agent and run_browser_agents."""

from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime
from uuid import uuid4

from backend.apps.agents.models import AgentSession, Message
from backend.apps.agents.manager.ws_manager import ws_manager
from backend.apps.common.model_registry import resolve_model_id
from backend.apps.tools_lib.tools_lib import load_builtin_permissions
from backend.apps.agents.manager.agent_manager import agent_manager
from backend.apps.settings.settings import load_settings
from backend.apps.settings.credentials import get_anthropic_client
from backend.apps.common.llm_helpers import _resolve_model as _resolve_9r
from backend.apps.dashboards.dashboards import _load, _save
from backend.apps.dashboards.models import BrowserCardPosition, BrowserTab
from backend.apps.analytics.collector import record as _analytics

from backend.apps.agents.browser.schemas import (
    BROWSER_TOOLS_SCHEMA, SYSTEM_PROMPT, MAX_TURNS,
)
from backend.apps.agents.browser.executor import (
    execute_browser_tool, _format_tool_result, _request_browser_approval,
)

logger = logging.getLogger(__name__)


async def run_browser_agent(
    task: str, browser_id: str, model: str,
    dashboard_id: str | None = None, tab_id: str = "",
    pre_selected: bool = False, initial_url: str | None = None,
    parent_session_id: str | None = None,
) -> dict:

    _browser_perms = load_builtin_permissions()
    session_id = uuid4().hex
    cancel_event = asyncio.Event()
    session = AgentSession(
        id=session_id, name="Browser Agent", model=model,
        mode="browser-agent", status="running", dashboard_id=dashboard_id,
        browser_id=browser_id, system_prompt=SYSTEM_PROMPT,
        parent_session_id=parent_session_id,
    )
    session._cancel_event = cancel_event
    agent_manager.sessions[session_id] = session

    await ws_manager.emit_status(session_id, "running", session)

    if initial_url:
        nav_result = await execute_browser_tool("BrowserNavigate", {"url": initial_url}, browser_id, tab_id)
        logger.info(f"Browser agent {session_id}: navigated to {initial_url}: {nav_result.get('text', nav_result.get('error', ''))}")

    api_model = resolve_model_id(model)
    _settings = load_settings()
    api_model = _resolve_9r(api_model, _settings)
    client = get_anthropic_client(_settings)

    messages: list[dict] = [{"role": "user", "content": task}]
    action_log: list[dict] = []
    final_screenshot: str | None = None

    user_msg = Message(role="user", content=task)
    session.messages.append(user_msg)
    await ws_manager.emit_message(session_id, user_msg)

    try:
        for _ in range(MAX_TURNS):
            if cancel_event.is_set():
                break
            response = await client.messages.create(
                model=api_model, max_tokens=4096, system=SYSTEM_PROMPT,
                tools=BROWSER_TOOLS_SCHEMA, messages=messages,
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
                    assistant_content.append({"type": "tool_use", "id": block.id, "name": block.name, "input": block.input})

            if text_parts:
                asst_msg = Message(role="assistant", content="\n".join(text_parts))
                session.messages.append(asst_msg)
                await ws_manager.emit_message(session_id, asst_msg)
            for tu in tool_uses:
                tool_msg = Message(role="tool_call", content={"id": tu.id, "tool": tu.name, "input": tu.input})
                session.messages.append(tool_msg)
                await ws_manager.emit_message(session_id, tool_msg)

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
                    tool_results.append({"type": "tool_result", "tool_use_id": tu.id, "content": [{"type": "text", "text": denied_text}]})
                    result_msg = Message(role="tool_result", content={"text": denied_text, "tool_name": tu.name, "elapsed_ms": 0})
                    session.messages.append(result_msg)
                    await ws_manager.emit_message(session_id, result_msg)
                    continue
                if policy == "ask":
                    decision = await _request_browser_approval(session, tu.name, tu.input)
                    if decision.get("behavior") == "deny":
                        denied_text = decision.get("message") or f"Tool {tu.name} denied by user."
                        tool_results.append({"type": "tool_result", "tool_use_id": tu.id, "content": [{"type": "text", "text": denied_text}]})
                        result_msg = Message(role="tool_result", content={"text": denied_text, "tool_name": tu.name, "elapsed_ms": 0})
                        session.messages.append(result_msg)
                        await ws_manager.emit_message(session_id, result_msg)
                        continue

                start = time.time()
                result = await execute_browser_tool(tu.name, tu.input, browser_id, tab_id)
                elapsed_ms = int((time.time() - start) * 1000)
                action_log.append({"tool": tu.name, "input": tu.input, "result_summary": result.get("text", result.get("error", ""))[:200], "elapsed_ms": elapsed_ms})
                if tu.name == "BrowserScreenshot" and result.get("image"):
                    final_screenshot = result["image"]
                content_blocks = _format_tool_result(result, tu.name)
                tool_results.append({"type": "tool_result", "tool_use_id": tu.id, "content": content_blocks})
                result_text = result.get("text", result.get("error", ""))
                result_msg = Message(role="tool_result", content={"text": result_text, "tool_name": tu.name, "elapsed_ms": elapsed_ms})
                session.messages.append(result_msg)
                await ws_manager.emit_message(session_id, result_msg)

            messages.append({"role": "user", "content": tool_results})
            if cancelled:
                break

        if cancel_event.is_set():
            session.status = "stopped"
            await ws_manager.emit_status(session_id, "stopped", session)
            return {"session_id": session_id, "browser_id": browser_id, "summary": "Agent was stopped.", "action_log": action_log, "final_screenshot": final_screenshot}

        summary_parts = text_parts if text_parts else ["Task completed."]
        summary = "\n".join(summary_parts)

        if not final_screenshot:
            try:
                ss_result = await execute_browser_tool("BrowserScreenshot", {}, browser_id, tab_id)
                if ss_result.get("image"):
                    final_screenshot = ss_result["image"]
            except Exception:
                pass

        session.status = "completed"
        await ws_manager.emit_status(session_id, "completed", session)
        return {"session_id": session_id, "browser_id": browser_id, "summary": summary, "action_log": action_log, "final_screenshot": final_screenshot}

    except Exception as e:
        logger.exception(f"Browser agent {session_id} error: {e}")
        session.status = "error"
        error_msg = Message(role="system", content=f"Error: {str(e)}")
        session.messages.append(error_msg)
        await ws_manager.emit_message(session_id, error_msg)
        await ws_manager.emit_status(session_id, "error", session)
        return {"session_id": session_id, "browser_id": browser_id, "summary": f"Error: {str(e)}", "action_log": action_log, "final_screenshot": None}


async def _create_browser_card(dashboard_id: str, url: str, parent_session_id: str | None = None) -> str:

    dashboard = _load(dashboard_id)
    browser_id = f"browser-{uuid4().hex[:8]}"
    tab_id = f"tab-{uuid4().hex[:8]}"
    tab = BrowserTab(id=tab_id, url=url or "https://www.google.com", title="")
    card = BrowserCardPosition(
        browser_id=browser_id, url=url or "https://www.google.com",
        tabs=[tab], activeTabId=tab_id, x=40, y=100, width=1280, height=800,
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
    tasks: list[dict], model: str,
    dashboard_id: str | None = None,
    pre_selected_browser_ids: list[str] | None = None,
    parent_session_id: str | None = None,
) -> list[dict]:
    _analytics("feature.used", {
        "feature": "browser_agent.launched", "task_count": len(tasks), "model": model,
    }, dashboard_id=dashboard_id)

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
            task=task_text, browser_id=browser_id, model=model,
            dashboard_id=dashboard_id, pre_selected=is_pre_selected,
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
