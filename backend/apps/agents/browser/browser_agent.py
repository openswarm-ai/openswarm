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

from backend.apps.agents.browser import browser_history
from backend.apps.agents.browser.browser_history import (
    _MAX_HISTORY_MESSAGES,
    _trim_history_by_turns,
    _validate_message_pairing,
    clear_browser_history,
)
from backend.apps.agents.browser.browser_loop import (
    _LOOP_DETECTION_EXCLUDED_TOOLS,
    _LOOP_HARD_CAP,
    _LOOP_WARNING_TEXT,
    _LOOP_WINDOW_SIZE,
    _detect_loop,
    _hash_tool_call,
)
from backend.apps.agents.browser.browser_schema import (
    _ACTION_TOOLS_REQUIRING_REPORT,
    ACTION_MAP,
    BROWSER_TOOLS_SCHEMA,
    MAX_TURNS,
    MODEL_MAP,
    SYSTEM_PROMPT,
)
from backend.apps.agents.core.models import AgentSession, ApprovalRequest, Message
from backend.apps.agents.core.ws_manager import ws_manager
from backend.apps.tools_lib.tools_lib import load_builtin_permissions

logger = logging.getLogger(__name__)


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


def _extract_domain(url: str) -> str | None:
    """Extract the apex domain from a URL (acme-corp.notion.so → notion.so).
    Returns None for non-http URLs."""
    try:
        from urllib.parse import urlparse
        parsed = urlparse(url)
        host = parsed.hostname or ""
        if not host or host in ("localhost", "127.0.0.1", ""):
            return None
        parts = host.split(".")
        if len(parts) >= 2:
            return ".".join(parts[-2:])
        return host
    except Exception:
        return None


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


async def run_browser_agent(
    task: str,
    browser_id: str,
    model: str,
    dashboard_id: str | None = None,
    tab_id: str = "",
    pre_selected: bool = False,
    initial_url: str | None = None,
    parent_session_id: str | None = None,
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

    # If parent was already stopped before we registered, bail immediately
    if parent_session_id:
        parent = agent_manager.sessions.get(parent_session_id)
        if parent and parent.status == "stopped":
            cancel_event.set()

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

    from backend.apps.settings.settings import load_settings
    from backend.apps.settings.credentials import get_anthropic_client_for_model
    from backend.apps.agents.providers.registry import (
        _find_builtin_model,
        resolve_model_id_for_sdk,
        resolve_aux_model,
    )
    browser_settings = load_settings()
    # Resolve the model string to whatever the SDK / 9Router expects.
    # When the parent session is running on a non-Claude model (e.g. gpt-5.4),
    # the browser agent inherits it and we route through 9Router's prefix.
    # Tool-use fidelity for browser-specific tools (BrowserNavigate, click,
    # type, etc.) through 9Router's claude→openai translator is UNVERIFIED , 
    # if translation is poor, the user should manually switch this session
    # back to Claude in the model picker.
    if _find_builtin_model(model) is not None:
        api_model = resolve_model_id_for_sdk(model, browser_settings)
    else:
        # Unknown model string; fall back to whatever aux model is available
        try:
            api_model, _ = await resolve_aux_model(browser_settings, preferred_tier="haiku")
        except ValueError:
            # Nothing connected at all; surface a clear error so the caller
            # (parent agent) sees it in the tool result instead of crashing
            # on a 400 from 9Router.
            session.status = "error"
            error_text = (
                "Browser agent requires an active LLM subscription. "
                "Connect Claude, Codex, or Gemini in Settings."
            )
            err_msg = Message(role="system", content=f"Error: {error_text}")
            session.messages.append(err_msg)
            await ws_manager.send_to_session(session_id, "agent:message", {
                "session_id": session_id,
                "message": err_msg.model_dump(mode="json"),
            })
            await ws_manager.send_to_session(session_id, "agent:status", {
                "session_id": session_id,
                "status": "error",
                "session": session.model_dump(mode="json"),
            })
            return {
                "session_id": session_id,
                "browser_id": browser_id,
                "summary": f"Error: {error_text}",
                "action_log": [],
                "final_screenshot": None,
            }
    # Route the client based on the resolved model id, not just
    # connection_mode. Without this, a pinned-route value like "sonnet-cc"
    # resolves to "cc/claude-sonnet-4-6" but the old get_anthropic_client()
    # still returned an OpenSwarm-proxy client (because connection_mode was
    # openswarm-pro), which then rejected the cc/ prefix and surfaced as a
    # misleading "OpenSwarm servers are busy" error.
    client = get_anthropic_client_for_model(browser_settings, api_model)

    # Resume prior conversation on this browser if we have one cached. This
    # lets the sub-agent skip the "take a screenshot to figure out where I am"
    # cycle every time the parent issues a new task. Defensively validate
    # the cache; if it's somehow corrupted (orphaned tool_use_ids), drop
    # it and start fresh rather than crash on the next API call.
    prior_messages = browser_history._browser_history.get(browser_id) or []
    if prior_messages and not _validate_message_pairing(prior_messages):
        logger.warning(
            f"[browser-agent {session_id}] cached history for {browser_id} has "
            f"orphaned tool_use_ids; dropping cache and starting fresh"
        )
        clear_browser_history(browser_id)
        prior_messages = []
    messages: list[dict] = list(prior_messages) + [{"role": "user", "content": task}]
    action_log: list[dict] = []
    final_screenshot: str | None = None

    # Loop detection state; sliding window of recent state-mutating tool calls
    recent_tool_calls: list[tuple[str, str, str]] = []
    loop_trigger_count = 0

    user_msg = Message(role="user", content=task)
    session.messages.append(user_msg)
    await ws_manager.send_to_session(session_id, "agent:message", {
        "session_id": session_id,
        "message": user_msg.model_dump(mode="json"),
    })

    async def _cancellable(coro):
        """Race any awaitable against the cancel event. Returns None if cancelled."""
        task = asyncio.ensure_future(coro)
        cancel_wait = asyncio.ensure_future(cancel_event.wait())
        done, pending = await asyncio.wait(
            [task, cancel_wait], return_when=asyncio.FIRST_COMPLETED,
        )
        for p in pending:
            p.cancel()
        if cancel_event.is_set():
            return None
        return task.result()

    text_parts = []  # initialized before loop so post-loop summary (line ~1294) has a default
    # Circuit breaker for ReportProgress violations. Some models get stuck
    # in a loop where they keep calling action tools without the brain-
    # state preamble. Each iteration of this loop pumps websocket events
    # to the frontend, which fans out to every useSelector subscriber and
    # tanks UI responsiveness. After N consecutive violations the agent
    # gives up and surfaces an error instead of churning through all
    # MAX_TURNS doing the same broken thing.
    consecutive_violations = 0
    MAX_CONSECUTIVE_VIOLATIONS = 3
    try:
        for turn in range(MAX_TURNS):
            if cancel_event.is_set():
                break

            response = await _cancellable(client.messages.create(
                model=api_model,
                max_tokens=4096,
                system=SYSTEM_PROMPT,
                tools=BROWSER_TOOLS_SCHEMA,
                messages=messages,
            ))
            if response is None:
                break
            # Guard against empty content (e.g. upstream API error from
            # 9Router that the SDK parsed into a partial response object).
            if not response.content:
                logger.warning(f"Browser agent {session_id}: empty response content from {api_model}")
                break

            # Track token usage from browser agent API calls
            if hasattr(response, 'usage') and response.usage:
                session.tokens["input"] = session.tokens.get("input", 0) + (response.usage.input_tokens or 0)
                session.tokens["output"] = session.tokens.get("output", 0) + (response.usage.output_tokens or 0)

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

            # Sort tool_uses so ReportProgress is always processed first within
            # a turn, even if the model emits it after action tools. This way
            # the brain state is recorded before any actions execute.
            has_report_progress = any(tu.name == "ReportProgress" for tu in tool_uses)
            has_action_tools = any(
                tu.name in _ACTION_TOOLS_REQUIRING_REPORT for tu in tool_uses
            )
            # Violation: action tools without ReportProgress in the same turn.
            # The model MUST articulate its evaluation/memory/goal before acting.
            report_progress_violation = has_action_tools and not has_report_progress
            if report_progress_violation:
                consecutive_violations += 1
                logger.warning(
                    f"[browser-agent {session_id}] ReportProgress violation "
                    f"({consecutive_violations}/{MAX_CONSECUTIVE_VIOLATIONS}): "
                    f"action tools called without brain state"
                )
                if consecutive_violations >= MAX_CONSECUTIVE_VIOLATIONS:
                    logger.error(
                        f"[browser-agent {session_id}] hit "
                        f"{MAX_CONSECUTIVE_VIOLATIONS} consecutive ReportProgress "
                        f"violations; aborting to prevent runaway loop"
                    )
                    # Surface a user-visible error message so the frontend
                    # shows something coherent instead of just stopping.
                    err_msg = Message(
                        role="assistant",
                        content=(
                            "I got stuck repeating the same action without "
                            "thinking it through. Stopping here so I don't "
                            "loop. Feel free to ask me to try again."
                        ),
                    )
                    session.messages.append(err_msg)
                    await ws_manager.send_to_session(session_id, "agent:message", {
                        "session_id": session_id,
                        "message": err_msg.model_dump(mode="json"),
                    })
                    break
            else:
                # Reset on a clean turn; only CONSECUTIVE violations
                # count toward the limit. A single bad turn followed by
                # a good one shouldn't kill the agent.
                consecutive_violations = 0
            # Stable sort: ReportProgress first, then everything else in order.
            tool_uses_sorted = sorted(
                tool_uses,
                key=lambda t: 0 if t.name == "ReportProgress" else 1,
            )

            for tu in tool_uses_sorted:
                if cancel_event.is_set():
                    cancelled = True
                    break

                # Handle ReportProgress; no-op execution that just records the
                # model's brain state and streams it to the dashboard.
                if tu.name == "ReportProgress":
                    eval_prev = tu.input.get("evaluation_previous", "")
                    working_mem = tu.input.get("working_memory", "")
                    next_goal = tu.input.get("next_goal", "")
                    brain_text = (
                        f"📋 **Plan**\n"
                        f"_Previous_: {eval_prev}\n"
                        f"_Memory_: {working_mem}\n"
                        f"_Next_: {next_goal}"
                    )
                    brain_msg = Message(role="assistant", content=brain_text)
                    session.messages.append(brain_msg)
                    await ws_manager.send_to_session(session_id, "agent:message", {
                        "session_id": session_id,
                        "message": brain_msg.model_dump(mode="json"),
                    })
                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": tu.id,
                        "content": [{"type": "text", "text": "Progress recorded."}],
                    })
                    continue

                # Reject action tools when ReportProgress is missing this turn.
                # We MUST still emit a tool_result for every tool_use_id or the
                # next API request 400s.
                if (
                    report_progress_violation
                    and tu.name in _ACTION_TOOLS_REQUIRING_REPORT
                ):
                    rejection_text = (
                        "REJECTED: You called an action tool without first calling "
                        "ReportProgress in the same turn. ReportProgress is REQUIRED "
                        "before every batch of action tools; it's how you reflect "
                        "on what just happened and articulate your next goal. Try "
                        "again: emit ReportProgress and your action tool(s) in the "
                        "same response."
                    )
                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": tu.id,
                        "content": [{"type": "text", "text": rejection_text}],
                        "is_error": True,
                    })
                    result_msg = Message(
                        role="tool_result",
                        content={
                            "text": rejection_text,
                            "tool_name": tu.name,
                            "elapsed_ms": 0,
                        },
                    )
                    session.messages.append(result_msg)
                    await ws_manager.send_to_session(session_id, "agent:message", {
                        "session_id": session_id,
                        "message": result_msg.model_dump(mode="json"),
                    })
                    continue

                # Handle RequestHumanIntervention; pause and wait for user
                if tu.name == "RequestHumanIntervention":
                    problem = tu.input.get("problem", "")
                    instruction = tu.input.get("instruction", "")
                    decision = await _request_browser_approval(
                        session, tu.name, {"problem": problem, "instruction": instruction},
                    )
                    if decision.get("behavior") != "deny":
                        result_text = "User resolved the issue. Continue with the task."
                    else:
                        user_message = decision.get("message", "").strip()
                        if user_message and user_message != "Skipped by user":
                            result_text = f"User skipped this intervention and said: \"{user_message}\"\nAddress what the user said and adapt your approach accordingly."
                        else:
                            result_text = "User skipped this intervention. Try a different approach or move on."
                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": tu.id,
                        "content": [{"type": "text", "text": result_text}],
                    })
                    result_msg = Message(
                        role="tool_result",
                        content={"text": result_text, "tool_name": tu.name, "elapsed_ms": 0},
                    )
                    session.messages.append(result_msg)
                    await ws_manager.send_to_session(session_id, "agent:message", {
                        "session_id": session_id,
                        "message": result_msg.model_dump(mode="json"),
                    })
                    continue

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
                result = await _cancellable(execute_browser_tool(
                    tu.name, tu.input, browser_id, tab_id,
                ))
                if result is None:
                    cancelled = True
                    break
                elapsed_ms = int((time.time() - start) * 1000)

                action_log.append({
                    "tool": tu.name,
                    "input": tu.input,
                    "result_summary": result.get("text", result.get("error", ""))[:200],
                    "elapsed_ms": elapsed_ms,
                })

                if tu.name == "BrowserScreenshot" and result.get("image"):
                    final_screenshot = result["image"]

                # Loop detection: did we just repeat the same (tool, input,
                # result) for the third time in a row? If so, attach a loud
                # warning to this tool_result so the model is forced to
                # acknowledge it on its next turn.
                call_key = _hash_tool_call(tu.name, tu.input, result)
                is_loop = _detect_loop(recent_tool_calls, call_key)
                if call_key[0] not in _LOOP_DETECTION_EXCLUDED_TOOLS:
                    recent_tool_calls.append(call_key)
                    if len(recent_tool_calls) > _LOOP_WINDOW_SIZE * 2:
                        recent_tool_calls = recent_tool_calls[-_LOOP_WINDOW_SIZE * 2:]

                content_blocks = _format_tool_result(result, tu.name)
                try:
                    url = result.get("url") or (tu.input or {}).get("url")
                    if url:
                        domain = _extract_domain(str(url))
                        if domain and domain not in session.browser_domains:
                            session.browser_domains.append(domain)
                except Exception:
                    pass
                if is_loop:
                    loop_trigger_count += 1
                    repeat_count = sum(1 for c in recent_tool_calls if c == call_key)
                    warning = _LOOP_WARNING_TEXT.format(count=repeat_count)
                    logger.warning(
                        f"[browser-agent {session_id}] loop detected on {tu.name} "
                        f"(trigger #{loop_trigger_count}): {warning}"
                    )
                    content_blocks = content_blocks + [
                        {"type": "text", "text": f"\n\n⚠️ {warning}"}
                    ]
                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": tu.id,
                    "content": content_blocks,
                    **({"is_error": True} if is_loop else {}),
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

            # Hard cap on loops: if the model keeps repeating itself even
            # after we warn it, force-exit so we don't burn the entire turn
            # budget on a stuck agent.
            if loop_trigger_count >= _LOOP_HARD_CAP:
                logger.warning(
                    f"[browser-agent {session_id}] hit loop hard cap "
                    f"({_LOOP_HARD_CAP}); force-exiting"
                )
                break

        if cancel_event.is_set():
            session.status = "stopped"
            await ws_manager.send_to_session(session_id, "agent:status", {
                "session_id": session_id,
                "status": "stopped",
                "session": session.model_dump(mode="json"),
            })
            return {
                "session_id": session_id,
                "browser_id": browser_id,
                "summary": "Agent was stopped by the user. Do NOT retry or create new browser agents.",
                "error": "Agent was stopped by the user.",
                "action_log": action_log,
                "final_screenshot": final_screenshot,
            }

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

        # Persist conversation history so the next BrowserAgent call on this
        # browser can resume rather than re-orient. Trim to the most recent
        # _MAX_HISTORY_MESSAGES turns to keep token usage bounded; but
        # never split a tool_use ↔ tool_result pair across the cut, or the
        # next API request will 400.
        browser_history._browser_history[browser_id] = _trim_history_by_turns(
            messages, _MAX_HISTORY_MESSAGES,
        )

        session.status = "completed"
        agent_manager._sync_session_close(session)
        await ws_manager.send_to_session(session_id, "agent:status", {
            "session_id": session_id,
            "status": "completed",
            "session": session.model_dump(mode="json"),
        })

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

        return {
            "session_id": session_id,
            "browser_id": browser_id,
            "summary": f"Error: {str(e)}",
            "action_log": action_log,
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
        spawned_by=parent_session_id,
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
    dashboard_id: str | None = None,
    pre_selected_browser_ids: list[str] | None = None,
    parent_session_id: str | None = None,
) -> list[dict]:
    """Run multiple browser sub-agents in parallel.

    Each task dict has: { browser_id (optional), task, url (optional) }
    Returns a list of result dicts, one per task.
    """
    pass  # Browser agent launch captured via session dump

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
