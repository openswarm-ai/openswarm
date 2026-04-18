"""Agent sessions sub-app.

Endpoints operate directly on a module-level sessions dict and the Agent class.
No manager layer — Agent already encapsulates its own runtime state.

The ws module is used ONLY in this file — the Agent class and its internals
communicate via the on_event callback, never importing ws directly.
"""

import asyncio
import os
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Optional, List, Dict
from uuid import uuid4

from fastapi import HTTPException, WebSocket, WebSocketDisconnect, Body
import json
from pydantic import BaseModel

from backend.config.Apps import SubApp
from backend.config.paths import DB_ROOT
from backend.core.Agent.Agent import Agent
from backend.core.db.PydanticStore import PydanticStore
from backend.core.shared_structs.agent.Message.Message import UserMessage
from backend.core.events.events import AgentStatusEvent, AgentClosedEvent, BranchSwitchedEvent
from backend.apps.agents.agent_utils.create_sdk_hooks import create_sdk_hooks
from backend.apps.agents.agent_utils.build_search_text import build_search_text
from backend.apps.agents.ResolvedModeConfig.ResolvedModeConfig import ResolvedModeConfig
from backend.apps.agents.COMMS_MANAGER.COMMS_MANAGER import COMMS_MANAGER
from backend.apps.settings.settings import load_settings
from backend.core.llm.resolve_sdk_env import resolve_sdk_env
from backend.ports import NINE_ROUTER_PORT
from claude_agent_sdk import ClaudeAgentOptions
from claude_agent_sdk.types import HookMatcher, McpServerConfig
from backend.core.tools.shared_structs.Toolkit import Toolkit
from backend.apps.agents.agent_utils.build_agent_toolkit import build_agent_toolkit

AGENT_STORE: PydanticStore[Agent] = PydanticStore[Agent](
    model_cls=Agent,
    data_dir=os.path.join(DB_ROOT, "sessions"),
    id_field="session_id",
    dump_mode="json",
    not_found_detail="Session not found in history",
)

# NOTE: Essentially the SESSIONS is a cache for active agents.
SESSIONS: dict[str, Agent] = {}

def get_agent(session_id: str) -> Agent:
    agent: Optional[Agent] = SESSIONS.get(session_id)
    if not agent:
        raise HTTPException(status_code=404, detail="Session not found")
    return agent

# ---------------------------------------------------------------------------
# Lifespan
# ---------------------------------------------------------------------------

@asynccontextmanager
async def agents_lifespan():
    for stored in AGENT_STORE.load_all():
        try:
            stored.status = "stopped"
            stored.on_event = COMMS_MANAGER.make_session_emitter(stored.session_id)
            stored.toolkit = build_agent_toolkit(
                agent=stored,
                sessions=SESSIONS,
                comms_manager=COMMS_MANAGER,
            )
            SESSIONS[stored.session_id] = stored
        except Exception as e:
            print(f"[agents lifespan] Skipping corrupt session {stored.session_id}: {e}")
    yield
    for agent in list[Agent](SESSIONS.values()):
        await agent.stop_agent()
        AGENT_STORE.save(agent)
    SESSIONS.clear()


agents = SubApp("agents", agents_lifespan)

# ---------------------------------------------------------------------------
# WebSocket
# ---------------------------------------------------------------------------
# TODO: type spec this more
@agents.router.websocket("/ws")
async def websocket_dashboard(websocket: WebSocket):
    await COMMS_MANAGER.broadcaster.connect(websocket)
    try:
        while True:
            raw: str = await websocket.receive_text()
            msg: dict = json.loads(raw)
            event: str = msg.get("event", "")
            payload: dict = msg.get("data", {})

            if event == "agent:approval_response":
                await COMMS_MANAGER.resolve_approval(
                    request_id=payload.get("request_id", ""),
                    behavior=payload.get("behavior", "deny"),
                    message=payload.get("message"),
                    updated_input=payload.get("updated_input"),
                )
            elif event == "browser:result":
                COMMS_MANAGER.browser_bridge.resolve(
                    payload.get("request_id", ""),
                    payload,
                )
    except WebSocketDisconnect:
        COMMS_MANAGER.broadcaster.disconnect(websocket)

# ---------------------------------------------------------------------------
# Session CRUD
# ---------------------------------------------------------------------------

@agents.router.get("/get_all_sessions")
async def get_all_sessions(dashboard_id: str = Body(default="")) -> dict:
    result: List[Agent] = list[Agent](SESSIONS.values())
    if dashboard_id:
        result: List[Agent] = [a for a in result if getattr(a, "dashboard_id", None) == dashboard_id]
    return {"sessions": [a.model_dump(mode="json") for a in result]}


@agents.router.get("/get_session")
async def get_session(session_id: str = Body()) -> dict:
    return get_agent(session_id).model_dump(mode="json")



@agents.router.post("/launch_agent")
async def launch_agent(
    model: str = Body(),
    mode: str = Body(),
    system_prompt: str = Body(),
    max_turns: int = Body(),
) -> dict:
    agent: Agent = Agent(
        model=model,
        mode=mode,
        status="stopped",
        config=ClaudeAgentOptions(max_turns=max_turns),
    )
    agent.on_event = COMMS_MANAGER.make_session_emitter(agent.session_id)
    SESSIONS[agent.session_id] = agent

    toolkit: Toolkit = build_agent_toolkit(
        agent=agent,
        sessions=SESSIONS,
        comms_manager=COMMS_MANAGER,
    )
    agent.toolkit = toolkit
    mcp_servers: Dict[str, McpServerConfig] = toolkit.collect_mcp_servers()

    resolved_mode_config: ResolvedModeConfig = await ResolvedModeConfig.create(
        mode_id=mode,
        session_prompt=system_prompt or None,
        toolkit=toolkit,
    )

    can_use_tool, pre_tool_hook, post_tool_hook = create_sdk_hooks(agent)

    settings = load_settings()
    env = resolve_sdk_env(
        api_key=settings.anthropic_api_key,
        nine_router_port=NINE_ROUTER_PORT if not settings.anthropic_api_key else None,
    )

    agent.config = ClaudeAgentOptions(
        env=env,
        model=model,
        system_prompt=resolved_mode_config.system_prompt,
        max_turns=max_turns,
        cwd=resolved_mode_config.cwd,
        mcp_servers=mcp_servers if mcp_servers else None,
        allowed_tools=resolved_mode_config.allowed_tools,
        disallowed_tools=resolved_mode_config.disallowed_tools,
        permission_mode="default",
        can_use_tool=can_use_tool,
        hooks={
            "PreToolUse": [HookMatcher(matcher=None, hooks=[pre_tool_hook])],
            "PostToolUse": [HookMatcher(matcher=None, hooks=[post_tool_hook])],
        },
    )

    await agent.emit(AgentStatusEvent(
        session_id=agent.session_id, status="stopped",
        session=agent.snapshot(),
    ))
    return {"session_id": agent.session_id, "session": agent.snapshot().model_dump(mode="json")}


@agents.router.patch("/update_system_prompt")
async def update_system_prompt(
    session_id: str = Body(),
    system_prompt: Optional[str] = Body(default=None),
) -> dict:
    agent: Agent = get_agent(session_id)
    if system_prompt is not None:
        agent.config.system_prompt = system_prompt
    await agent.emit(AgentStatusEvent(
        session_id=session_id, status=agent.status,
        session=agent.snapshot(),
    ))
    return {"ok": True}


@agents.router.delete("/delete_session")
async def delete_session(session_id: str = Body()) -> dict:
    agent: Optional[Agent] = SESSIONS.pop(session_id, None)
    if agent is not None:
        await agent.stop_agent()
    AGENT_STORE.delete(session_id)
    return {"ok": True}


# ---------------------------------------------------------------------------
# Agent lifecycle
# ---------------------------------------------------------------------------

class MessageBody(BaseModel):
    prompt: str
    mode: Optional[str] = None
    model: Optional[str] = None
    images: Optional[List[str]] = None
    image_media_types: Optional[List[str]] = None
    context_paths: Optional[List[dict]] = None
    forced_tools: Optional[List[str]] = None
    attached_skills: Optional[List[dict]] = None
    hidden: bool = False

@agents.router.post("/send_message")
async def send_message(
    session_id: str = Body(),
    prompt: str = Body(),
    mode: Optional[str] = Body(default=None),
    model: Optional[str] = Body(default=None),
    images: Optional[List[str]] = Body(default=None),
    image_media_types: Optional[List[str]] = Body(default=None),
    context_paths: Optional[List[dict]] = Body(default=None),
    forced_tools: Optional[List[str]] = Body(default=None),
    attached_skills: Optional[List[dict]] = Body(default=None),
    hidden: bool = Body(default=False),

) -> dict:
    agent: Agent = get_agent(session_id)
    mode_changed: bool = bool(mode and mode != agent.mode)
    model_changed: bool = bool(model and model != agent.model)

    if mode_changed:
        agent.mode = mode  # type: ignore[assignment]
    if model_changed:
        agent.model = model  # type: ignore[assignment]

    if mode_changed or model_changed:
        resolved_mode_config: ResolvedModeConfig = await ResolvedModeConfig.create(
            mode_id=agent.mode,
            session_prompt=agent.config.system_prompt,
            toolkit=agent.toolkit,
        )
        agent.config.system_prompt = resolved_mode_config.system_prompt
        agent.config.model = agent.model
        agent.config.allowed_tools = resolved_mode_config.allowed_tools
        agent.config.disallowed_tools = resolved_mode_config.disallowed_tools
        if resolved_mode_config.cwd:
            agent.config.cwd = resolved_mode_config.cwd

    msg: UserMessage = UserMessage(
        content=prompt,
        branch_id=agent.branch_id,
        images=images or [],
        image_media_types=image_media_types or [],
        context_paths=context_paths or [],
        attached_skills=attached_skills or [],
        forced_tools=forced_tools or [],
        hidden=hidden,
    )
    await agent.send_message(msg)
    return {"ok": True}


@agents.router.post("/stop_agent")
async def stop_agent(session_id: str = Body()) -> dict:
    agent: Agent = get_agent(session_id)
    await agent.stop_agent()
    return {"ok": True}


@agents.router.post("/handle_approval")
async def handle_approval(
    request_id: str = Body(),
    behavior: str = Body(),
    message: str = Body(default=""),
    updated_input: Optional[dict] = Body(default=None),
) -> dict:
    await COMMS_MANAGER.resolve_approval(
        request_id=request_id,
        behavior=behavior,
        message=message,
        updated_input=updated_input,
    )
    return {"ok": True}


# ---------------------------------------------------------------------------
# Branching
# ---------------------------------------------------------------------------


@agents.router.post("/edit_message")
async def edit_message(
    session_id: str = Body(),
    message_id: str = Body(),
    content: str = Body(),
) -> dict:
    agent: Agent = get_agent(session_id)
    await agent.stop_agent()
    fork: Agent = agent.branch(message_id)
    SESSIONS[fork.session_id] = fork

    edited_msg: UserMessage = UserMessage(content=content, branch_id=fork.branch_id)
    await fork.send_message(edited_msg)
    return {"ok": True, "branch_id": fork.branch_id, "session_id": fork.session_id}


@agents.router.post("/switch_branch")
async def switch_branch(
    session_id: str = Body(),
    branch_id: str = Body(),
) -> dict:
    agent: Agent = get_agent(session_id)
    agent.branch_id = branch_id
    await agent.emit(BranchSwitchedEvent(
        session_id=session_id, active_branch_id=branch_id,
    ))
    return {"ok": True}


# ---------------------------------------------------------------------------
# Persistence
# ---------------------------------------------------------------------------

@agents.router.post("/close_session")
async def close_session(session_id: str = Body()) -> dict:
    agent: Optional[Agent] = SESSIONS.pop(session_id, None)
    if not agent:
        raise HTTPException(status_code=404, detail="Session not found")
    await agent.stop_agent()
    AGENT_STORE.save(agent)
    msgs = agent.messages.messages
    closed_at: str = msgs[-1].timestamp.isoformat() if msgs else datetime.now().isoformat()
    await agent.emit(AgentClosedEvent(
        session_id=session_id, status=agent.status,
        closed_at=closed_at,
    ))
    return {"ok": True}


@agents.router.post("/resume_session")
async def resume_session(session_id: str = Body()) -> dict:
    if session_id in SESSIONS:
        return {"session": SESSIONS[session_id].model_dump(mode="json")}
    agent: Optional[Agent] = AGENT_STORE.load_or_none(session_id)
    if not agent:
        raise HTTPException(status_code=404, detail="Session not found in history")
    agent.status = "stopped"
    agent.on_event = COMMS_MANAGER.make_session_emitter(agent.session_id)
    agent.toolkit = build_agent_toolkit(
        agent=agent,
        sessions=SESSIONS,
        comms_manager=COMMS_MANAGER,
    )
    SESSIONS[agent.session_id] = agent
    AGENT_STORE.delete(session_id)
    await agent.emit(AgentStatusEvent(
        session_id=session_id, status=agent.status,
        session=agent.snapshot(),
    ))
    return {"session": agent.snapshot().model_dump(mode="json")}


@agents.router.post("/duplicate_session")
async def duplicate_session(session_id: str = Body()) -> dict:
    source: Optional[Agent] = SESSIONS.get(session_id)
    if source is None:
        source = AGENT_STORE.load_or_none(session_id)
        if not source:
            raise HTTPException(status_code=404, detail="Session not found")

    clone: Agent = source.model_copy(deep=True)
    clone.session_id = uuid4().hex
    clone.status = "stopped"
    clone.task = None
    clone.lock = asyncio.Lock()
    clone.pending_approvals = []
    clone.sub_agents = []
    clone.on_event = COMMS_MANAGER.make_session_emitter(clone.session_id)
    clone.toolkit = build_agent_toolkit(
        agent=clone,
        sessions=SESSIONS,
        comms_manager=COMMS_MANAGER,
    )
    SESSIONS[clone.session_id] = clone
    await clone.emit(AgentStatusEvent(
        session_id=clone.session_id, status=clone.status,
        session=clone.snapshot(),
    ))
    return {"session": clone.snapshot().model_dump(mode="json")}


@agents.router.get("/get_history")
async def get_history(
    q: str = Body(default=""),
    limit: int = Body(default=20),
    offset: int = Body(default=0),
) -> dict:
    all_agents: List[Agent] = AGENT_STORE.load_all()
    all_agents.sort(
        key=lambda a: a.messages.messages[-1].timestamp if a.messages.messages else datetime.min,
        reverse=True,
    )

    q_lower: str = q.strip().lower()
    history: List[dict] = []
    for agent in all_agents:
        if q_lower:
            search_text: str = build_search_text(agent).lower()
            if q_lower not in search_text:
                continue
        msgs = agent.messages.messages
        closed_at: str = msgs[-1].timestamp.isoformat() if msgs else ""
        history.append({
            "id": agent.session_id,
            "status": agent.status,
            "model": agent.model,
            "mode": agent.mode,
            "closed_at": closed_at,
        })

    total: int = len(history)
    page: List[dict] = history[offset : offset + limit]
    return {"sessions": page, "total": total, "has_more": offset + limit < total}