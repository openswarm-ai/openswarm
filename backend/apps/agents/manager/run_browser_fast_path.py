"""Direct browser-agent dispatch that skips the orchestrator LLM. Lifted out of
agent_manager so the general orchestrator doesn't carry browser-specific code."""

import asyncio
import logging
import time
from datetime import datetime
from typing import Dict, List, Optional
from uuid import uuid4

from typeguard import typechecked

from backend.apps.agents.core.models import AgentSession, Message
from backend.apps.agents.core.ws_manager import ws_manager
from backend.apps.agents.manager.session.session_store import save_session
from backend.apps.settings.settings import load_settings

logger = logging.getLogger(__name__)


@typechecked
async def run_browser_fast_path(
    session: AgentSession,
    session_id: str,
    prompt: str,
    selected_browser_ids: Optional[List[str]],
    brief: str = "",
    verdict: str = "act",
) -> None:
    """Dispatch the browser sub-agent directly and reply with its outcome;
    the orchestrator LLM never runs. READ verdicts try one local fetch +
    aux answer first (seconds, no browser); any miss falls into the browser
    leg. A failed browser dispatch gets ONE informed recovery dispatch (the
    orchestrator's old retry role). stop_agent still works: it cancels this
    task and the children."""
    p_fp_t0 = time.monotonic()
    p_fp_path = verdict
    logger.info(f"[browser-fast-path] direct dispatch for session {session_id} ({verdict})")
    text = ""
    # The fast-path skips the orchestrator, so the UI never gets the BrowserAgent tool-call that draws the "Browser Agent" bubble. Emit a synthetic tool_call/ tool_result pair (same shape + mcp__ name the orchestrator uses) so the bubble shows here too. None until we actually dispatch a browser (a pure READ answer has no browser, so no bubble).
    p_browser_tool = "mcp__openswarm-browser-agent__CreateBrowserAgent"
    p_bubble_tid: Optional[str] = None
    try:
        from backend.apps.agents.browser.browser_agent import run_browser_agents
        from backend.apps.agents.browser import browser_fast_path
        selected = [b for b in (selected_browser_ids or []) if b]

        if verdict == "read":
            from backend.apps.agents.browser import browser_fast_read
            from backend.apps.agents.providers.registry import get_api_type
            text = await browser_fast_read.try_fast_read(
                prompt, brief, load_settings(), get_api_type(session.model),
            ) or ""
            if not text:
                p_fp_path = "read->browser"

        p_entry = browser_fast_path.entry_url_from_brief(brief)
        if p_entry:
            logger.info(f"[browser-cold] brief entry url for {session_id}: {p_entry}")

        @typechecked
        async def p_dispatch(task_text: str) -> Dict[str, object]:
            results = await run_browser_agents(
                tasks=[{"task": task_text, "browser_id": selected[0] if selected else "",
                        "url": "", "entry_url": p_entry}],
                model=session.model,
                dashboard_id=session.dashboard_id,
                pre_selected_browser_ids=selected,
                parent_session_id=session_id,
            )
            r = results[0] if results else {}
            return r if isinstance(r, dict) else {"summary": str(r or ""), "action_log": []}

        @typechecked
        def p_summary(r: Dict[str, object]) -> str:
            return (str(r.get("summary") or "")).strip()

        if not text:
            # show the "Browser Agent" bubble during the dispatch (it renders as running, then completes when we emit the matching result below)
            p_bubble_tid = uuid4().hex
            p_tc = Message(role="tool_call", branch_id=session.active_branch_id,
                           content={"id": p_bubble_tid, "tool": p_browser_tool, "input": {"task": prompt}})
            session.messages.append(p_tc)
            await ws_manager.send_to_session(session_id, "agent:message", {
                "session_id": session_id, "message": p_tc.model_dump(mode="json")})
            first = await p_dispatch(browser_fast_path.compose_task(prompt, brief))
            text = p_summary(first)
            if browser_fast_path.dispatch_failed(first):
                # Retry only transient failures; a dead dashboard fails the retry identically, so skip it and tell the user instead.
                if not ws_manager.global_connections:
                    p_fp_path += "+no-dashboard"
                    text = browser_fast_path.NO_DASHBOARD_REPLY
                else:
                    from backend.apps.agents.browser import browser_batch_replay
                    payload = browser_batch_replay.send_payload_from_log(first.get("action_log"), prompt)
                    if payload:
                        # The dead attempt had already typed into a composer, so a blind retry risks a double-send: a read-only probe's verdict gates the retry in code, not prose.
                        logger.info(f"[browser-fast-path] send-zone failure for {session_id}; payload probe before any retry")
                        probe_text = p_summary(await p_dispatch(browser_fast_path.send_probe_task(prompt, payload)))
                        pv = browser_fast_path.probe_verdict(probe_text)
                        logger.info(f"[browser-fast-path] send-probe verdict={pv} for {session_id}")
                        p_fp_path += f"+send-probe={pv}"
                        if pv == "found":
                            text = browser_fast_path.already_sent_reply(payload, probe_text)
                        elif pv == "not-found":
                            text = p_summary(await p_dispatch(
                                browser_fast_path.recovery_task(prompt, text, verified_undelivered=True)))
                        else:
                            text = browser_fast_path.unverifiable_reply(payload, text)
                    else:
                        logger.info(f"[browser-fast-path] first dispatch failed for {session_id}; one recovery dispatch")
                        p_fp_path += "+recovery"
                        text = p_summary(await p_dispatch(browser_fast_path.recovery_task(prompt, text)))
            if not text:
                text = "The browser agent couldn't complete this and gave no report."
    except asyncio.CancelledError:
        raise
    except Exception as e:
        logger.warning(f"[browser-fast-path] dispatch failed: {e}")
        text = f"The browser agent couldn't complete this: {e}"

    logger.info(
        f"[browser-fast-path] session {session_id} done: path={p_fp_path} "
        f"reply={len(text)}ch in {int((time.monotonic() - p_fp_t0) * 1000)}ms"
    )
    # Close the synthetic bubble (always, even if the dispatch threw) so it never hangs as "running"; the bubble pairs this result with its call positionally.
    if p_bubble_tid:
        p_tr = Message(role="tool_result", branch_id=session.active_branch_id,
                       content={"tool_use_id": p_bubble_tid, "tool": p_browser_tool, "text": "done"})
        session.messages.append(p_tr)
        await ws_manager.send_to_session(session_id, "agent:message", {
            "session_id": session_id, "message": p_tr.model_dump(mode="json")})
    asst_msg = Message(role="assistant", content=text, branch_id=session.active_branch_id)
    session.messages.append(asst_msg)
    await ws_manager.send_to_session(session_id, "agent:message", {
        "session_id": session_id,
        "message": asst_msg.model_dump(mode="json"),
    })
    session.status = "completed"
    session.closed_at = datetime.now()
    await ws_manager.send_to_session(session_id, "agent:status", {
        "session_id": session_id,
        "status": "completed",
        "session": session.model_dump(mode="json"),
    })
    try:
        save_session(session_id, session.model_dump(mode="json"))
    except Exception as e:
        logger.warning(f"Failed to snapshot session {session_id}: {e}")
