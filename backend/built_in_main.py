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
from backend.routing import ProviderManager, Router
from backend.agent_orchestrator import AgentOrchestrator
from backend.github_integration import GithubIntegration
from backend.agent_modes import AGENT_MODES

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# --- App State ---
class AppState:
    def __init__(self):
        self.sessions: Dict[str, AgentSession] = {}
        self.orchestrators: Dict[str, AgentOrchestrator] = {}
        self.router: Optional[Router] = None

state = AppState()

# --- Initialization ---
@asynccontextmanager
async def main_lifespan():
    logger.info("Initializing OpenSwarm++...")
    # Load multi-provider config from .openswarmpp if available
    config_path = os.path.join(os.getcwd(), ".openswarmpp", "providers.json")
    provider_configs = []
    if os.path.exists(config_path):
        with open(config_path, "r") as f:
            provider_configs = json.load(f)
    else:
        # Fallback to env vars or default
        provider_configs = [{
            "name": "default",
            "provider": os.environ.get("DEFAULT_PROVIDER", "anthropic"),
            "api_key": os.environ.get("DEFAULT_API_KEY", "missing"),
            "default_model": "sonnet"
        }]

    pm = ProviderManager(provider_configs)
    state.router = Router(pm)
    yield
    logger.info("Shutting down OpenSwarm++...")

# --- Health SubApp ---
health = SubApp("health", main_lifespan)
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
    mode_key = data.get("mode", "default")
    mode_config = AGENT_MODES.get(mode_key, AGENT_MODES["default"])

    config = AgentConfig(**data)
    session = AgentSession(
        name=config.name,
        model=config.model or "sonnet",
        provider=config.provider or "anthropic",
        mode=mode_key,
        cwd=config.target_directory or os.getcwd(),
        system_prompt=mode_config["system_prompt"]
    )

    state.sessions[session.id] = session

    # Initialize orchestrator
    provider = state.router.pm.get_provider(session.provider)
    if not provider:
        provider = next(iter(state.router.pm.providers.values()))

    orch = AgentOrchestrator(session.id, provider, session.model, session.cwd)
    state.orchestrators[session.id] = orch

    return HttpResponse(200, {"Content-Type": "application/json"}, json.dumps(session.model_dump(mode="json")).encode())

async def agents_ws_handler(ws: WebSocket):
    await ws.accept()
    session_id = ws.path.split("/")[-1].split("?")[0]

    if session_id not in state.orchestrators:
        await ws.send_text(json.dumps({"event": "error", "data": "Session not found"}))
        await ws.close()
        return

    await ws_manager.connect_session(session_id, ws)
    try:
        while True:
            data = await ws.receive_text()
            if not data: break
            msg = json.loads(data)
            event = msg.get("event")
            payload = msg.get("data", {})

            if event == "agent:send_message":
                prompt = payload.get("prompt")
                orch = state.orchestrators[session_id]
                session = state.sessions[session_id]

                # Run in thread/task to avoid blocking WS loop
                result = await orch.run(prompt, system_prompt=session.system_prompt)
                await ws.send_text(json.dumps({
                    "event": "agent:message",
                    "data": {"content": result}
                }))
    except Exception as e:
        logger.error(f"WS Error for session {session_id}: {e}")
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
    # Ensure build folder for C extension is present
    # In a real setup, we would verify performance module here
    asyncio.run(app.run())
