import logging
import os
from uuid import uuid4

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
    datefmt="%H:%M:%S",
)

logger = logging.getLogger(__name__)

from fastapi.responses import JSONResponse
from fastapi import Request
from backend.config.Apps import MainApp
from backend.apps.health.health import health
from backend.apps.agents.agents import agents
from backend.apps.agents.ws_manager import ws_manager
from backend.apps.templates.templates import templates
from backend.apps.skills.skills import skills
from backend.apps.tools_lib.tools_lib import tools_lib
from backend.apps.modes.modes import modes
from backend.apps.settings.settings import settings
from backend.apps.mcp_registry.mcp_registry import mcp_registry
from backend.apps.skill_registry.skill_registry import skill_registry
from backend.apps.outputs.outputs import outputs
from backend.apps.dashboards.dashboards import dashboards
from backend.apps.schedules.schedules import schedules
from fastapi.middleware.cors import CORSMiddleware
from fastapi import WebSocket, WebSocketDisconnect
import json

main_app = MainApp([health, agents, templates, skills, tools_lib, modes, settings, mcp_registry, skill_registry, outputs, dashboards, schedules])
app = main_app.app

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.websocket("/ws/agents/{session_id}")
async def websocket_session(websocket: WebSocket, session_id: str):
    await ws_manager.connect_session(session_id, websocket)
    try:
        while True:
            data = await websocket.receive_text()
            msg = json.loads(data)
            event = msg.get("event")
            payload = msg.get("data", {})
            
            if event == "agent:send_message":
                from backend.apps.agents.agent_manager import agent_manager
                await agent_manager.send_message(
                    session_id,
                    payload.get("prompt", ""),
                    mode=payload.get("mode"),
                    model=payload.get("model"),
                    images=payload.get("images"),
                )
            elif event == "agent:approval_response":
                from backend.apps.agents.agent_manager import agent_manager
                agent_manager.handle_approval(payload.get("request_id"), {
                    "behavior": payload.get("behavior", "deny"),
                    "message": payload.get("message"),
                    "updated_input": payload.get("updated_input"),
                })
            elif event == "agent:edit_message":
                from backend.apps.agents.agent_manager import agent_manager
                await agent_manager.edit_message(
                    session_id,
                    payload.get("message_id", ""),
                    payload.get("content", ""),
                )
            elif event == "agent:stop":
                from backend.apps.agents.agent_manager import agent_manager
                await agent_manager.stop_agent(session_id)
    except WebSocketDisconnect:
        ws_manager.disconnect_session(session_id, websocket)

@app.websocket("/ws/dashboard")
async def websocket_dashboard(websocket: WebSocket):
    await ws_manager.connect_global(websocket)
    try:
        while True:
            data = await websocket.receive_text()
            msg = json.loads(data)
            event = msg.get("event")
            payload = msg.get("data", {})
            
            if event == "agent:approval_response":
                from backend.apps.agents.agent_manager import agent_manager
                agent_manager.handle_approval(payload.get("request_id"), {
                    "behavior": payload.get("behavior", "deny"),
                    "message": payload.get("message"),
                    "updated_input": payload.get("updated_input"),
                })
            elif event == "browser:result":
                ws_manager.resolve_browser_command(
                    payload.get("request_id", ""),
                    payload,
                )
    except WebSocketDisconnect:
        ws_manager.disconnect_global(websocket)


@app.post("/api/browser/command")
async def browser_command(request: Request):
    """HTTP endpoint called by the browser MCP server subprocess.
    Proxies commands to the frontend via WebSocket and waits for results."""
    body = await request.json()
    action = body.get("action", "")
    browser_id = body.get("browser_id", "")
    tab_id = body.get("tab_id", "")
    params = body.get("params", {})

    if not action or not browser_id:
        return JSONResponse({"error": "action and browser_id are required"}, status_code=400)

    request_id = uuid4().hex
    result = await ws_manager.send_browser_command(request_id, action, browser_id, params, tab_id=tab_id)
    return JSONResponse(result)


@app.post("/api/browser-agent/run")
async def browser_agent_run(request: Request):
    """Run one or more browser sub-agents in parallel.
    Called by the browser_agent_mcp_server stdio subprocess."""
    from backend.apps.settings.settings import load_settings
    from backend.apps.agents.browser_agent import run_browser_agents

    body = await request.json()
    tasks = body.get("tasks", [])
    model = body.get("model", "sonnet")
    dashboard_id = body.get("dashboard_id", "")
    pre_selected_browser_ids = body.get("pre_selected_browser_ids", [])
    parent_session_id = body.get("parent_session_id", "")

    if not tasks:
        return JSONResponse({"error": "tasks array is required"}, status_code=400)

    settings = load_settings()

    results = await run_browser_agents(
        tasks=tasks,
        model=model,
        api_key=settings.anthropic_api_key or None,
        dashboard_id=dashboard_id or None,
        pre_selected_browser_ids=pre_selected_browser_ids,
        parent_session_id=parent_session_id or None,
    )
    return JSONResponse({"results": results})


@app.post("/api/invoke-agent/run")
async def invoke_agent_run(request: Request):
    """Fork an existing agent session and send it a new message.
    Called by the invoke_agent_mcp_server stdio subprocess."""
    body = await request.json()
    session_id = body.get("session_id", "")
    message = body.get("message", "")
    parent_session_id = body.get("parent_session_id", "")
    dashboard_id = body.get("dashboard_id", "")

    if not session_id:
        return JSONResponse({"error": "session_id is required"}, status_code=400)
    if not message:
        return JSONResponse({"error": "message is required"}, status_code=400)

    try:
        from backend.apps.agents.agent_manager import agent_manager
        result = await agent_manager.invoke_agent(
            source_session_id=session_id,
            message=message,
            parent_session_id=parent_session_id or None,
            dashboard_id=dashboard_id or None,
        )
        return JSONResponse(result)
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=404)
    except Exception as e:
        logger.exception("invoke_agent_run failed")
        return JSONResponse({"error": str(e)}, status_code=500)


if __name__ == "__main__":
    import argparse
    import uvicorn

    parser = argparse.ArgumentParser(description="OpenSwarm backend server")
    parser.add_argument("--port", type=int, default=int(os.environ.get("OPENSWARM_PORT", "8324")))
    parser.add_argument("--host", default=os.environ.get("OPENSWARM_HOST", "127.0.0.1"))
    parser.add_argument("--reload", action="store_true", default=False)
    args = parser.parse_args()

    os.environ["OPENSWARM_PORT"] = str(args.port)

    import uvicorn.config

    class _ReadyServer(uvicorn.Server):
        """Subclass that prints a machine-readable READY line on startup."""
        async def startup(self, sockets=None):
            await super().startup(sockets)
            print(f"READY:PORT={args.port}", flush=True)

    if args.reload:
        uvicorn.run("backend.main:app", host=args.host, port=args.port, reload=True)
    else:
        config = uvicorn.Config("backend.main:app", host=args.host, port=args.port)
        server = _ReadyServer(config)
        import asyncio
        asyncio.run(server.serve())
