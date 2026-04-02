"""Agent sessions sub-app.

Endpoints operate directly on a module-level sessions dict and the Agent class.
No manager layer — Agent already encapsulates its own runtime state.
"""

from contextlib import asynccontextmanager
from datetime import datetime
from uuid import uuid4
import asyncio

from fastapi import HTTPException
from pydantic import BaseModel
from typing import Optional, List

from backend.config.Apps import SubApp
from backend.apps.HaikFix.Agent.Agent import Agent
from backend.apps.HaikFix.Agent.shared_structs.Message.Message import UserMessage
from backend.apps.HaikFix import session_store
from backend.apps.agents.manager.ws_manager import ws_manager  # TODO: move to HaikFix
from claude_agent_sdk import ClaudeAgentOptions


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
    await session_store.reconcile_on_startup()
    for sid, data in session_store.load_all():
        if data.get("closed_at") is not None:
            continue
        try:
            data.pop("task", None)
            data.pop("lock", None)
            agent: Agent = Agent(**data)
            agent.status = "stopped"
            SESSIONS[agent.session_id] = agent
            session_store.delete(sid)
        except Exception as e:
            print(f"[agents lifespan] Skipping corrupt session {sid}: {e}")
    yield
    for agent in list[Agent](SESSIONS.values()):
        await agent.stop_agent()
        data: dict = agent.model_dump(mode="json")
        data["search_text"] = session_store.build_search_text(data)
        session_store.save(agent.session_id, data)
    SESSIONS.clear()


agents = SubApp("agents", agents_lifespan)


# ---------------------------------------------------------------------------
# Session CRUD
# ---------------------------------------------------------------------------

@agents.router.get("/SESSIONS")
async def list_sessions(dashboard_id: str = "") -> dict:
    result: List[Agent] = list[Agent](SESSIONS.values())
    if dashboard_id:
        result: List[Agent] = [a for a in result if getattr(a, "dashboard_id", None) == dashboard_id]
    return {"SESSIONS": [a.model_dump(mode="json") for a in result]}


@agents.router.get("/sessions/{session_id}")
async def get_session(session_id: str) -> dict:
    return get_agent(session_id).model_dump(mode="json")


class LaunchBody(BaseModel):
    name: str = "New Agent"
    model: str = "sonnet"
    mode: str = "agent"
    system_prompt: str = ""
    max_turns: int = 200
    target_directory: Optional[str] = None
    dashboard_id: Optional[str] = None

@agents.router.post("/launch")
async def launch(body: LaunchBody) -> dict:
    # TODO: build ClaudeAgentOptions from body once prompt/options builder exists
    # For now this is a placeholder — the config must be constructed here
    agent: Agent = Agent(
        model=body.model,
        mode=body.mode,
        status="running",
        config=ClaudeAgentOptions(
            system_prompt=body.system_prompt,
            max_turns=body.max_turns,
        ),
    )
    SESSIONS[agent.session_id] = agent
    await ws_manager.emit_status(agent.session_id, "running", agent)
    return {"session_id": agent.session_id, "session": agent.model_dump(mode="json")}


class UpdateBody(BaseModel):
    name: Optional[str] = None
    system_prompt: Optional[str] = None

@agents.router.patch("/SESSIONS/{session_id}")
async def update_session(session_id: str, body: UpdateBody) -> dict:
    agent: Agent = get_agent(session_id)
    if body.name is not None:
        agent.name = body.name
    if body.system_prompt is not None:
        agent.config.system_prompt = body.system_prompt
    await ws_manager.emit_status(session_id, agent.status, agent)
    return {"ok": True}


@agents.router.delete("/sessions/{session_id}")
async def delete_session(session_id: str) -> dict:
    agent: Optional[Agent] = SESSIONS.pop(session_id, None)
    if agent is not None:
        await agent.stop_agent()
    session_store.delete(session_id)
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

@agents.router.post("/SESSIONS/{session_id}/message")
async def send_message(session_id: str, body: MessageBody) -> dict:
    agent: Agent = get_agent(session_id)
    if body.mode and body.mode != agent.mode:
        agent.mode = body.mode
    if body.model and body.model != agent.model:
        agent.model = body.model

    msg: UserMessage = UserMessage(
        content=body.prompt,
        branch_id=agent.branch_id,
        images=body.images or [],
        image_media_types=body.image_media_types or [],
        context_paths=body.context_paths or [],
        attached_skills=body.attached_skills or [],
        forced_tools=body.forced_tools or [],
        hidden=body.hidden,
    )
    await agent.send_message(msg)
    return {"ok": True}


@agents.router.post("/sessions/{session_id}/stop")
async def stop_agent(session_id: str) -> dict:
    agent: Agent = get_agent(session_id)
    await agent.stop_agent()
    return {"ok": True}


class ApprovalBody(BaseModel):
    request_id: str
    behavior: str
    message: str = ""
    updated_input: Optional[dict] = None

@agents.router.post("/approval")
async def handle_approval(body: ApprovalBody) -> dict:
    ws_manager.resolve_approval(body.request_id, {
        "behavior": body.behavior,
        "message": body.message,
        "updated_input": body.updated_input,
    })
    return {"ok": True}


# ---------------------------------------------------------------------------
# Branching
# ---------------------------------------------------------------------------

class EditMessageBody(BaseModel):
    message_id: str
    content: str

@agents.router.post("/sessions/{session_id}/edit_message")
async def edit_message(session_id: str, body: EditMessageBody) -> dict:
    agent: Agent = get_agent(session_id)
    await agent.stop_agent()
    fork: Agent = agent.branch(body.message_id)
    SESSIONS[fork.session_id] = fork

    edited_msg = UserMessage(content=body.content, branch_id=fork.branch_id)
    await fork.send_message(edited_msg)
    return {"ok": True, "branch_id": fork.branch_id, "session_id": fork.session_id}


class SwitchBranchBody(BaseModel):
    branch_id: str

@agents.router.post("/SESSIONS/{session_id}/switch_branch")
async def switch_branch(session_id: str, body: SwitchBranchBody) -> dict:
    agent: Agent = get_agent(session_id)
    agent.branch_id = body.branch_id
    await ws_manager.emit_branch_switched(session_id, body.branch_id)
    return {"ok": True}


# ---------------------------------------------------------------------------
# Persistence
# ---------------------------------------------------------------------------

@agents.router.post("/sessions/{session_id}/close")
async def close_session(session_id: str) -> dict:
    agent: Optional[Agent] = SESSIONS.pop(session_id, None)
    if not agent:
        raise HTTPException(status_code=404, detail="Session not found")
    await agent.stop_agent()
    data: dict = agent.model_dump(mode="json")
    data["search_text"] = session_store.build_search_text(data)
    data["closed_at"] = datetime.now().isoformat()
    session_store.save(session_id, data)
    await ws_manager.emit_closed(session_id, agent)
    return {"ok": True}


@agents.router.post("/SESSIONS/{session_id}/resume")
async def resume_session(session_id: str) -> dict:
    if session_id in SESSIONS:
        return {"session": SESSIONS[session_id].model_dump(mode="json")}
    data: Optional[dict] = session_store.load(session_id)
    if not data:
        raise HTTPException(status_code=404, detail="Session not found in history")
    data.pop("task", None)
    data.pop("lock", None)
    data.pop("search_text", None)
    data.pop("closed_at", None)
    agent: Agent = Agent(**data)
    agent.status = "stopped"
    SESSIONS[agent.session_id] = agent
    session_store.delete(session_id)
    await ws_manager.emit_status(session_id, agent.status, agent)
    return {"session": agent.model_dump(mode="json")}


@agents.router.post("/SESSIONS/{session_id}/duplicate")
async def duplicate_session(session_id: str, body: dict = {}) -> dict:
    source: Optional[Agent] = SESSIONS.get(session_id)
    if source is None:
        data: Optional[dict] = session_store.load(session_id)
        if not data:
            raise HTTPException(status_code=404, detail="Session not found")
        data.pop("task", None)
        data.pop("lock", None)
        new_source: Agent = Agent(**data)
        source = new_source
    assert source is not None, "Source agent not found"

    clone: Agent = source.model_copy(deep=True)
    clone.session_id = uuid4().hex
    clone.status = "stopped"
    clone.task = None
    clone.lock = asyncio.Lock()
    clone.pending_approvals = []
    clone.sub_agents = []
    SESSIONS[clone.session_id] = clone
    await ws_manager.emit_status(clone.session_id, clone.status, clone)
    return {"session": clone.model_dump(mode="json")}


@agents.router.get("/history")
async def get_history(q: str = "", limit: int = 20, offset: int = 0, dashboard_id: str = "") -> dict:
    return session_store.get_history(
        q=q, limit=limit, offset=offset,
        dashboard_id=dashboard_id or None,
    )