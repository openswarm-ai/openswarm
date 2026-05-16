import asyncio
import json
import logging
import os
import re
import sys
import time
from datetime import datetime
from uuid import uuid4
from typing import Optional, Callable, List, Dict, Any
from contextlib import asynccontextmanager, AsyncExitStack

from backend.builtin_server import BuiltinServer, HttpRequest, HttpResponse, WebSocket
from backend.auth import (
    init_auth_token,
    is_path_exempt,
    request_matches_token,
    is_origin_allowed,
)

logger = logging.getLogger(__name__)

class SubApp:
    def __init__(self, name: str, lifespan: Callable):
        self.name = name
        self.prefix = f"/api/{name}"
        self.lifespan = lifespan
        self.routes = [] # List of (method, path, handler)
        self.ws_routes = [] # List of (pattern, handler)

    def get(self, path: str):
        def decorator(handler):
            self.routes.append(("GET", path, handler))
            return handler
        return decorator

    def post(self, path: str):
        def decorator(handler):
            self.routes.append(("POST", path, handler))
            return handler
        return decorator

class MainApp:
    def __init__(self, sub_apps: List[SubApp]):
        self.sub_apps = sub_apps
        self.server = BuiltinServer()
        self._setup_routes()
        self.server.add_middleware(self._auth_middleware)

    def _setup_routes(self):
        for sub_app in self.sub_apps:
            for method, path, handler in sub_app.routes:
                full_path = sub_app.prefix + path
                self.server.add_route(method, full_path, handler)
            for pattern, handler in sub_app.ws_routes:
                self.server.add_ws_route(pattern, handler)

    async def _auth_middleware(self, request: HttpRequest) -> Optional[HttpResponse]:
        if request.method == "OPTIONS":
            return HttpResponse(200, self._cors_headers(), b"")

        if is_path_exempt(request.path):
            return None

        if not request_matches_token(request.headers, request.query_params):
            return HttpResponse(401, {"Content-Type": "application/json"}, json.dumps({"error": "unauthorized"}).encode())

        return None

    def _cors_headers(self) -> Dict[str, str]:
        return {
            "Access-Control-Allow-Origin": "*", # Adjust as needed based on backend/main.py
            "Access-Control-Allow-Methods": "*",
            "Access-Control-Allow-Headers": "*",
            "Access-Control-Allow-Private-Network": "true"
        }

    async def run(self):
        init_auth_token()
        async with AsyncExitStack() as stack:
            for sub_app in self.sub_apps:
                await stack.enter_async_context(sub_app.lifespan())

            port = int(os.environ.get("OPENSWARM_PORT", "8324"))
            self.server.port = port
            print(f"READY:PORT={port}")
            await self.server.start()

# Re-implementing health app for example
@asynccontextmanager
async def health_lifespan():
    yield

health = SubApp("health", health_lifespan)

@health.get("/check")
async def check(request: HttpRequest):
    return HttpResponse(200, {"Content-Type": "text/plain"}, b"OK")

if __name__ == "__main__":
    app = MainApp([health])
    asyncio.run(app.run())
