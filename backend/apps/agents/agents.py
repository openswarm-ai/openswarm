from backend.config.Apps import SubApp
from backend.apps.agents.agent_manager import agent_manager
from backend.apps.agents.ws_manager import ws_manager
from backend.apps.agents.models import AgentConfig, ApprovalResponse
from contextlib import asynccontextmanager
from fastapi import WebSocket, WebSocketDisconnect, HTTPException
from fastapi.responses import JSONResponse
import json
import logging
import subprocess
import sys
import shutil

logger = logging.getLogger(__name__)

@asynccontextmanager
async def agents_lifespan():
    logger.info("Agents sub-app starting")
    await agent_manager.reconcile_on_startup()
    await agent_manager.restore_all_sessions()
    yield
    logger.info("Agents sub-app shutting down")
    for session_id in list(agent_manager.tasks.keys()):
        await agent_manager.stop_agent(session_id)
    await agent_manager.persist_all_sessions()

agents = SubApp("agents", agents_lifespan)

# REST Endpoints

@agents.router.get("/sessions")
async def list_sessions(dashboard_id: str = ""):
    sessions = agent_manager.get_all_sessions(dashboard_id=dashboard_id or None)
    return {"sessions": [s.model_dump(mode="json") for s in sessions]}

@agents.router.get("/sessions/{session_id}")
async def get_session(session_id: str):
    session = agent_manager.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return session.model_dump(mode="json")

@agents.router.post("/launch")
async def launch_agent(config: AgentConfig):
    session = await agent_manager.launch_agent(config)
    return {"session_id": session.id, "session": session.model_dump(mode="json")}

@agents.router.post("/sessions/{session_id}/message")
async def send_message(session_id: str, body: dict):
    prompt = body.get("prompt", "")
    if not prompt:
        raise HTTPException(status_code=400, detail="prompt is required")
    await agent_manager.send_message(
        session_id,
        prompt,
        mode=body.get("mode"),
        model=body.get("model"),
        images=body.get("images"),
        context_paths=body.get("context_paths"),
        forced_tools=body.get("forced_tools"),
        attached_skills=body.get("attached_skills"),
        hidden=body.get("hidden", False),
        selected_browser_ids=body.get("selected_browser_ids"),
    )
    return {"ok": True}

@agents.router.post("/sessions/{session_id}/stop")
async def stop_agent(session_id: str):
    await agent_manager.stop_agent(session_id)
    return {"ok": True}

@agents.router.post("/approval")
async def handle_approval(response: ApprovalResponse):
    agent_manager.handle_approval(response.request_id, {
        "behavior": response.behavior,
        "message": response.message,
        "updated_input": response.updated_input,
    })
    return {"ok": True}

@agents.router.post("/sessions/{session_id}/edit_message")
async def edit_message(session_id: str, body: dict):
    message_id = body.get("message_id")
    new_content = body.get("content", "")
    if not message_id or not new_content:
        raise HTTPException(status_code=400, detail="message_id and content are required")
    await agent_manager.edit_message(session_id, message_id, new_content)
    return {"ok": True}

@agents.router.post("/sessions/{session_id}/switch_branch")
async def switch_branch(session_id: str, body: dict):
    branch_id = body.get("branch_id", "")
    if not branch_id:
        raise HTTPException(status_code=400, detail="branch_id is required")
    await agent_manager.switch_branch(session_id, branch_id)
    return {"ok": True}

@agents.router.post("/sessions/{session_id}/generate-title")
async def generate_title(session_id: str, body: dict):
    prompt = body.get("prompt", "")
    if not prompt:
        raise HTTPException(status_code=400, detail="prompt is required")
    title = await agent_manager.generate_title(session_id, prompt)
    return {"title": title}

@agents.router.post("/sessions/{session_id}/generate-group-meta")
async def generate_group_meta(session_id: str, body: dict):
    group_id = body.get("group_id", "")
    tool_calls = body.get("tool_calls", [])
    if not group_id or not tool_calls:
        raise HTTPException(status_code=400, detail="group_id and tool_calls are required")
    result = await agent_manager.generate_group_meta(
        session_id,
        group_id,
        tool_calls,
        results_summary=body.get("results_summary"),
        is_refinement=body.get("is_refinement", False),
    )
    return result

@agents.router.patch("/sessions/{session_id}")
async def update_session(session_id: str, body: dict):
    session = agent_manager.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    await agent_manager.update_session(session_id, **body)
    return {"ok": True}

@agents.router.get("/sessions/{session_id}/branches")
async def get_branches(session_id: str):
    session = agent_manager.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return {
        "branches": {k: v.model_dump(mode="json") for k, v in session.branches.items()},
        "active_branch_id": session.active_branch_id,
    }

@agents.router.post("/sessions/{session_id}/duplicate")
async def duplicate_session(session_id: str, body: dict = {}):
    try:
        session = await agent_manager.duplicate_session(
            session_id,
            dashboard_id=body.get("dashboard_id"),
            up_to_message_id=body.get("up_to_message_id"),
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return {"session": session.model_dump(mode="json")}

@agents.router.post("/sessions/{session_id}/close")
async def close_session(session_id: str):
    try:
        await agent_manager.close_session(session_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return {"ok": True}

@agents.router.delete("/sessions/{session_id}")
async def delete_session(session_id: str):
    await agent_manager.delete_session(session_id)
    return {"ok": True}

@agents.router.get("/history")
async def get_history(q: str = "", limit: int = 20, offset: int = 0, dashboard_id: str = ""):
    return agent_manager.get_history(
        q=q, limit=limit, offset=offset,
        dashboard_id=dashboard_id or None,
    )

@agents.router.get("/sessions/{session_id}/browser-agents")
async def get_browser_agent_children(session_id: str):
    children = agent_manager.get_browser_agent_children(session_id)
    return {"sessions": children}

@agents.router.post("/sessions/{session_id}/open-in-cli")
async def open_in_cli(session_id: str):
    session = agent_manager.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    if not session.sdk_session_id:
        raise HTTPException(status_code=400, detail="Session has no CLI session ID (agent may not have run yet)")

    claude_path = shutil.which("claude")
    if not claude_path:
        raise HTTPException(status_code=500, detail="Claude CLI not found on PATH")

    args = [claude_path, "--resume", session.sdk_session_id]
    cwd = session.cwd or None

    try:
        if sys.platform == "win32":
            subprocess.Popen(
                ["cmd.exe", "/c", "start", "cmd.exe", "/k"] + args,
                cwd=cwd, creationflags=subprocess.DETACHED_PROCESS,
            )
        elif sys.platform == "darwin":
            script = f'tell application "Terminal" to do script "cd {cwd or "~"} && {claude_path} --resume {session.sdk_session_id}"'
            subprocess.Popen(["osascript", "-e", script])
        else:
            for term in ["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"]:
                term_path = shutil.which(term)
                if term_path:
                    if "gnome-terminal" in term:
                        subprocess.Popen([term_path, "--"] + args, cwd=cwd)
                    else:
                        subprocess.Popen([term_path, "-e", " ".join(args)], cwd=cwd)
                    break
            else:
                raise HTTPException(status_code=500, detail="No terminal emulator found")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    return {"ok": True, "sdk_session_id": session.sdk_session_id}

@agents.router.post("/sessions/{session_id}/resume")
async def resume_session(session_id: str):
    try:
        session = await agent_manager.resume_session(session_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return {"session": session.model_dump(mode="json")}

