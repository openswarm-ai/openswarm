import asyncio
import json
import logging
import os
import sys
from uuid import uuid4
from datetime import datetime
from contextlib import asynccontextmanager

from backend.app_framework import MainApp, SubApp, HttpRequest, HttpResponse, WebSocket
from backend.apps.agents.models import AgentConfig, AgentSession, Message
from backend.apps.agents.ws_manager import ws_manager
from backend.providers.base import get_provider
from backend.agent_orchestrator import AgentOrchestrator
from backend.github_integration import GithubIntegration

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# --- Health SubApp ---
@asynccontextmanager
async def health_lifespan():
    yield

health = SubApp("health", health_lifespan)
@health.get("/check")
async def health_check(request: HttpRequest):
    return HttpResponse(200, {"Content-Type": "text/plain"}, b"OK")

# --- Agents SubApp ---
@asynccontextmanager
async def agents_lifespan():
    yield

agents = SubApp("agents", agents_lifespan)

@agents.post("/sessions")
async def create_session(request: HttpRequest):
    data = request.json()
    config = AgentConfig(**data)

    session = AgentSession(
        name=config.name,
        model=config.model,
        provider=config.provider,
        mode=config.mode,
        cwd=config.target_directory or os.getcwd()
    )
    # Save session logic would go here
    return HttpResponse(200, {"Content-Type": "application/json"}, json.dumps(session.model_dump(mode="json")).encode())

async def agents_ws_handler(ws: WebSocket):
    await ws.accept()
    session_id = ws.path.split("/")[-1].split("?")[0]
    logger.info(f"WebSocket connected for session {session_id}")

    await ws_manager.connect_session(session_id, ws)
    try:
        while True:
            data = await ws.receive_text()
            if not data: break
            msg = json.loads(data)
            event = msg.get("event")
            payload = msg.get("data", {})

            if event == "agent:send_message":
                # Trigger orchestrator
                # Note: In a real implementation, this should be non-blocking
                prompt = payload.get("prompt")
                # orchestrator = AgentOrchestrator(session_id, ...)
                # result = await orchestrator.run(prompt)
                # await ws.send_text(json.dumps({"event": "agent:message", "data": {"content": result}}))
                pass
    except Exception as e:
        logger.error(f"WS Error: {e}")
    finally:
        ws_manager.disconnect_session(session_id, ws)

agents.ws_routes.append((r"^/ws/agents/.*", agents_ws_handler))

# --- Github SubApp ---
@asynccontextmanager
async def github_lifespan():
    yield

github = SubApp("github", github_lifespan)

@github.post("/import")
async def github_import(request: HttpRequest):
    data = request.json()
    url = data.get("url")
    target = data.get("target_dir", os.path.join(os.getcwd(), "imports", uuid4().hex))
    result = GithubIntegration.import_repository(url, target)
    return HttpResponse(200, {"Content-Type": "application/json"}, json.dumps({"message": result, "target_dir": target}).encode())

# --- Main App Assembly ---
app = MainApp([health, agents, github])

if __name__ == "__main__":
    asyncio.run(app.run())
