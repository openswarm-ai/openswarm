from typing import List
import os
import argparse
import socket
from typing import Optional
import uvicorn
from typeguard import typechecked
from backend.ports import get_backend_port
from backend.config.Apps import MainApp
from backend.apps.health.health import health
from backend.apps.agents.agents import agents
from backend.apps.settings.settings import settings
from backend.apps.dashboards.dashboards import dashboards
from fastapi.middleware.cors import CORSMiddleware

main_app = MainApp([
    health, agents, settings, dashboards
])
app = main_app.app

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

if __name__ == "__main__":

    parser: argparse.ArgumentParser = argparse.ArgumentParser(description="OpenSwarm backend server")
    parser.add_argument("--port", type=int, default=get_backend_port())
    parser.add_argument("--host", default=os.environ.get("OPENSWARM_HOST", "127.0.0.1"))
    parser.add_argument("--reload", action="store_true", default=False)
    args: argparse.Namespace = parser.parse_args()

    os.environ["OPENSWARM_PORT"] = str(args.port)

    class P_ReadyServer(uvicorn.Server):
        """Subclass that prints a machine-readable READY line on startup."""
        @typechecked
        async def startup(self, sockets: Optional[List[socket.socket]] = None) -> None:
            await super().startup(sockets)
            print(f"READY:PORT={args.port}", flush=True)

    if args.reload:
        uvicorn.run("backend.main:app", host=args.host, port=args.port, reload=True)
    else:
        config = uvicorn.Config("backend.main:app", host=args.host, port=args.port)
        server = P_ReadyServer(config)
        import asyncio
        asyncio.run(server.serve())
