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
        self.routes = []
        self.ws_routes = []

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
        self.settings = self._load_settings()
        self._setup_routes()
        self.server.add_middleware(self._auth_middleware)

    def _load_settings(self) -> Dict[str, Any]:
        settings = {
            "default_model": "sonnet",
            "default_provider": "anthropic",
            "allowed_tools": ["read_file", "write_file", "list_files", "run_command"]
        }

        config_path = os.path.join(os.getcwd(), ".openswarmpp", "config.json")
        if os.path.exists(config_path):
            try:
                with open(config_path, "r") as f:
                    user_config = json.load(f)
                    settings.update(user_config)
                    logger.info(f"Loaded config from {config_path}")
            except Exception as e:
                logger.error(f"Error loading config: {e}")
        return settings

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
            "Access-Control-Allow-Origin": "*",
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
