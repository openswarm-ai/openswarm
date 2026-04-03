"""tools_lib package — SubApp instance, lifespan, and route wiring."""

from __future__ import annotations

import os
from contextlib import asynccontextmanager

from backend.config.Apps import SubApp
from backend.config.paths import TOOLS_DIR as DATA_DIR

from backend.apps.tools_lib import routes, oauth, mcp_discovery


@asynccontextmanager
async def tools_lib_lifespan():
    os.makedirs(DATA_DIR, exist_ok=True)
    yield


tools_lib = SubApp("tools", tools_lib_lifespan)

# CRUD + permissions
tools_lib.router.add_api_route("/builtin", routes.list_builtin_tools, methods=["GET"])
tools_lib.router.add_api_route("/builtin/permissions", routes.get_builtin_permissions, methods=["GET"])
tools_lib.router.add_api_route("/builtin/permissions", routes.update_builtin_permissions, methods=["PUT"])
tools_lib.router.add_api_route("/list", routes.list_tools, methods=["GET"])
tools_lib.router.add_api_route("/create", routes.create_tool, methods=["POST"])

# OAuth
tools_lib.router.add_api_route("/oauth/callback", oauth.oauth_callback, methods=["GET"])

# Per-tool routes (order matters: specific paths before {tool_id})
tools_lib.router.add_api_route("/{tool_id}/discover", mcp_discovery.discover_tools, methods=["POST"])
tools_lib.router.add_api_route("/{tool_id}/oauth/disconnect", oauth.oauth_disconnect, methods=["POST"])
tools_lib.router.add_api_route("/{tool_id}/oauth/start", oauth.oauth_start, methods=["POST"])
tools_lib.router.add_api_route("/{tool_id}", routes.get_tool, methods=["GET"])
tools_lib.router.add_api_route("/{tool_id}", routes.update_tool, methods=["PUT"])
tools_lib.router.add_api_route("/{tool_id}", routes.delete_tool, methods=["DELETE"])
