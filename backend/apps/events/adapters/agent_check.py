"""The universal poll adapter: a real agent session verifies ANY
natural-language condition on an interval, with the same tools, MCP gate, and
admission bounds as a normal chat turn. Contract: the agent ends its reply
with EVENT:/NO_EVENT + STATE: lines; state round-trips through the cursor so
"since the last check" means something. Check sessions are plumbing, not chat
history: they're deleted after each check so they can't pollute history or
the pattern miner."""

import asyncio
import hashlib
import time
from typing import Dict, List, Optional, Tuple

from typeguard import typechecked

from backend.apps.events.models import AgentCheckSource, Event
from backend.apps.workflows.models import Workflow

CHECK_TIMEOUT_S = 240.0


@typechecked
def build_check_prompt(check: str, state: str) -> str:
    return (
        "You are an unattended event checker. Determine whether this event has occurred "
        f"since the last check: {check.strip()}\n\n"
        f"Previous check state: {state or 'none; this is the baseline check'}.\n\n"
        "Use your tools as needed, then END your reply in EXACTLY this format (as the final lines):\n"
        "EVENT: <one factual line describing what happened>\n"
        "STATE: <one line capturing what you observed, to compare against next time>\n"
        "If nothing new happened, instead end with:\n"
        "NO_EVENT\n"
        "STATE: <one line>\n"
        "On the baseline check (no previous state) always reply NO_EVENT and just record STATE."
    )


@typechecked
def parse_check_reply(text: str) -> Tuple[Optional[str], str]:
    """(event line or None, state). Last occurrence wins so earlier prose echoing
    the format can't fake a verdict. Raises when the contract is missing entirely."""
    event_line: Optional[str] = None
    state = ""
    saw_verdict = False
    for line in text.splitlines():
        s = line.strip()
        if s.upper().startswith("EVENT:"):
            event_line = s[len("EVENT:"):].strip()
            saw_verdict = True
        elif s.upper() == "NO_EVENT":
            event_line = None
            saw_verdict = True
        elif s.upper().startswith("STATE:"):
            state = s[len("STATE:"):].strip()
    if not saw_verdict:
        raise ValueError("check agent returned no EVENT/NO_EVENT verdict")
    return event_line, state


async def p_await_reply(session_id: str) -> str:
    from backend.apps.agents.agent_manager import agent_manager

    deadline = time.monotonic() + CHECK_TIMEOUT_S
    while time.monotonic() < deadline:
        sess = agent_manager.sessions.get(session_id)
        if sess is None or getattr(sess, "status", None) in ("completed", "error", "stopped"):
            break
        await asyncio.sleep(0.5)
    sess = agent_manager.sessions.get(session_id)
    if sess is None:
        raise RuntimeError("check session vanished")
    status = getattr(sess, "status", None)
    if status == "running":
        try:
            await agent_manager.stop_agent(session_id)
        except Exception:
            pass
        raise RuntimeError(f"check agent timed out after {int(CHECK_TIMEOUT_S)}s")
    if status != "completed":
        raise RuntimeError(f"check agent ended with status {status}")
    for m in reversed(getattr(sess, "messages", []) or []):
        if getattr(m, "role", None) == "assistant" and isinstance(getattr(m, "content", None), str) and m.content.strip():
            return m.content
    raise RuntimeError("check agent produced no reply")


async def run_check_turn(
    model: str,
    prompt: str,
    dashboard_id: Optional[str] = None,
    active_mcps: Optional[List[str]] = None,
    approvals: Optional[Dict[str, str]] = None,
) -> str:
    """One ephemeral agent turn; the session file is deleted afterward.

    dashboard_id makes browser delegation available (browser cards render on a
    dashboard, so a logged-in-site check works whenever the app is open).
    active_mcps presets session.active_mcps with what the USER pre-authorized
    on the trigger; the dispatch gate itself still only spawns what that list
    names. approvals replays the workflow's remembered tool answers so an
    unattended check doesn't park on a prompt nobody will answer."""
    from backend.apps.agents.agent_manager import agent_manager
    from backend.apps.agents.core.models import AgentConfig
    from backend.apps.agents.manager.permissions.workflow_approval import (
        clear_workflow_approval_memory,
        set_workflow_approval_memory,
    )
    from backend.apps.agents.manager.session.session_store import delete_session_file

    session = await agent_manager.launch_agent(AgentConfig(
        name="Event check", model=model, mode="agent", dashboard_id=dashboard_id,
    ))
    if active_mcps:
        session.active_mcps = list(active_mcps)
    if approvals:
        set_workflow_approval_memory(
            session.id,
            decisions=dict(approvals),
            step_usage={},
            remember=lambda tool_name, behavior: None,
            ask_timeout=30.0,
        )
    try:
        await agent_manager.send_message(session.id, prompt)
        return await p_await_reply(session.id)
    finally:
        try:
            clear_workflow_approval_memory(session.id)
        except Exception:
            pass
        try:
            await agent_manager.close_session(session.id)
        except Exception:
            pass
        try:
            delete_session_file(session.id)
        except Exception:
            pass


@typechecked
async def agent_check(source: AgentCheckSource, cursor: Dict, workflow: Optional[Workflow] = None) -> Tuple[List[Event], Dict]:
    check = source.check.strip()
    if not check:
        return [], cursor
    from backend.apps.settings.settings import load_settings
    from backend.apps.workflows.executor import resolve_workflow_dashboard_id

    baselined = bool(cursor.get("baselined")) and cursor.get("check") == check
    prev_state = str(cursor.get("state") or "") if baselined else ""
    model = source.model.strip() or (workflow.model if workflow else "") or (getattr(load_settings(), "default_model", None) or "sonnet")
    reply = await run_check_turn(
        model,
        build_check_prompt(check, prev_state),
        dashboard_id=resolve_workflow_dashboard_id(workflow) if workflow else None,
        active_mcps=list(source.mcps),
        approvals=dict(workflow.remembered_approvals) if workflow else None,
    )
    event_line, state = parse_check_reply(reply)
    new_cursor: Dict = {"baselined": True, "check": check, "state": state or prev_state}
    if cursor.get("last_event_digest"):
        new_cursor["last_event_digest"] = cursor["last_event_digest"]
    # Baseline never fires, even if the model ignores the instruction.
    if event_line is None or not event_line.strip() or not baselined:
        return [], new_cursor
    digest = hashlib.sha256(event_line.strip().encode()).hexdigest()[:16]
    if cursor.get("last_event_digest") == digest:
        # The agent re-reported the identical event (state parroting); once is enough.
        return [], new_cursor
    new_cursor["last_event_digest"] = digest
    return [Event(
        source="agent",
        event_type="check_event",
        summary=event_line.strip()[:300],
        dedup_key=digest,
        payload={"check": check, "state": state},
    )], new_cursor
