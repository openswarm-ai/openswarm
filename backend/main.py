import os

from fastapi.responses import JSONResponse
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
from fastapi.middleware.cors import CORSMiddleware
from fastapi import WebSocket, WebSocketDisconnect
import json

main_app = MainApp([health, agents, templates, skills, tools_lib, modes, settings, mcp_registry, skill_registry, outputs, dashboards])
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
    except WebSocketDisconnect:
        ws_manager.disconnect_global(websocket)

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
