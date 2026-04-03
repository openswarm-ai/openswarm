"""Build ClaudeAgentOptions kwargs and MCP server configuration.

Extracted from agent_loop.py to keep every file under 250 lines.
"""

from __future__ import annotations

import json
import logging
import os
import sys

from backend.apps.agents.models import AgentSession
from backend.apps.agents.execution.prompt_builder import resolve_mode, compose_system_prompt
from backend.apps.agents.execution.prompt_context import (
    build_connected_tools_context,
    build_browser_context, get_pre_selected_browser_ids,
)
from backend.apps.agents.execution.mcp_builder import (
    FULL_TOOLS, build_mcp_servers, get_all_tool_names,
    _get_denied_tool_names, _get_all_known_tool_names, _is_fully_denied,
)
from backend.apps.settings.settings import load_settings
from backend.apps.tools_lib.tools_lib import (
    _load_all as load_all_tools
)
from backend.apps.common.mcp_utils import sanitize_server_name as _sanitize_server_name
from backend.ports import BACKEND_DEV_PORT, NINE_ROUTER_PORT

from claude_agent_sdk.types import HookMatcher

from backend.apps.outputs.view_builder_templates import VIEW_BUILDER_SKILL

from backend.apps.common.model_registry import resolve_model_id as _resolve_mid

from backend.apps.nine_router import is_running as _9r_running




logger = logging.getLogger(__name__)


async def build_agent_options(
    session: AgentSession,
    builtin_perms: dict,
    can_use_tool,
    pre_tool_hook,
    post_tool_hook,
    fork_session: bool = False,
    selected_browser_ids: list[str] | None = None,
) -> dict:
    """Build the kwargs dict for ClaudeAgentOptions.

    Requires claude_agent_sdk types to be imported by the caller; they are
    passed in via the hook callables.
    """

    _, mode_sys_prompt, _ = resolve_mode(session.mode, get_all_tool_names)
    connected_tools_ctx = build_connected_tools_context(
        session.allowed_tools, load_all_tools, get_all_tool_names, _is_fully_denied, _get_denied_tool_names,
    )
    browser_ctx = build_browser_context(session.dashboard_id, selected_browser_ids=selected_browser_ids)
    global_settings = load_settings()
    composed_prompt = compose_system_prompt(
        global_settings.default_system_prompt, mode_sys_prompt, session.system_prompt,
        connected_tools_ctx, browser_ctx,
    )

    if session.mode == "view-builder":
        skill_block = f"<app_builder_reference>\n{VIEW_BUILDER_SKILL}\n</app_builder_reference>"
        composed_prompt = f"{composed_prompt}\n\n{skill_block}" if composed_prompt else skill_block

    mcp_servers = await build_mcp_servers(session.allowed_tools)

    _browser_delegation_tools = ["CreateBrowserAgent", "BrowserAgent", "BrowserAgents"]
    _browser_all_denied = all(builtin_perms.get(t, "always_allow") == "deny" for t in _browser_delegation_tools)

    if not _browser_all_denied:
        browser_agent_server_path = os.path.join(os.path.dirname(__file__), "browser_agent_mcp_server.py")
        backend_port = os.environ.get("OPENSWARM_PORT", str(BACKEND_DEV_PORT))
        pre_selected_bids = get_pre_selected_browser_ids(session.dashboard_id)
        mcp_servers["openswarm-browser-agent"] = {
            "command": sys.executable,
            "args": [browser_agent_server_path],
            "env": {
                "OPENSWARM_PORT": backend_port,
                "OPENSWARM_AGENT_MODEL": session.model,
                "OPENSWARM_DASHBOARD_ID": session.dashboard_id or "",
                "OPENSWARM_PRE_SELECTED_BROWSER_IDS": ",".join(pre_selected_bids),
                "OPENSWARM_PARENT_SESSION_ID": session.id,
            },
            "type": "stdio",
        }

    _invoke_agent_tools = ["InvokeAgent"]
    _invoke_all_denied = all(builtin_perms.get(t, "always_allow") == "deny" for t in _invoke_agent_tools)

    if not _invoke_all_denied:
        invoke_agent_server_path = os.path.join(os.path.dirname(__file__), "invoke_agent_mcp_server.py")
        backend_port = os.environ.get("OPENSWARM_PORT", str(BACKEND_DEV_PORT))
        mcp_servers["openswarm-invoke-agent"] = {
            "command": sys.executable,
            "args": [invoke_agent_server_path],
            "env": {
                "OPENSWARM_PORT": backend_port,
                "OPENSWARM_PARENT_SESSION_ID": session.id,
                "OPENSWARM_DASHBOARD_ID": session.dashboard_id or "",
            },
            "type": "stdio",
        }

    effective_allowed, effective_disallowed = _compute_tool_permissions(
        session, builtin_perms, mcp_servers, _browser_delegation_tools, _invoke_agent_tools,
    )

    options_kwargs: dict = {
        "model": session.model,
        "max_buffer_size": 5 * 1024 * 1024,
        "permission_mode": "default",
        "can_use_tool": can_use_tool,
        "hooks": {
            "PreToolUse": [HookMatcher(matcher=None, hooks=[pre_tool_hook])],
            "PostToolUse": [HookMatcher(matcher=None, hooks=[post_tool_hook])],
        },
        "allowed_tools": effective_allowed,
        "disallowed_tools": effective_disallowed,
        "include_partial_messages": True,
    }

    if global_settings.anthropic_api_key:
        options_kwargs["env"] = {"ANTHROPIC_API_KEY": global_settings.anthropic_api_key}
        logger.info("[MCP-DEBUG] Using direct API key")
    elif _9r_running():
        options_kwargs["env"] = {
            "ANTHROPIC_API_KEY": "9router",
            "ANTHROPIC_BASE_URL": f"http://localhost:{NINE_ROUTER_PORT}",
        }
        options_kwargs["extra_args"] = {"bare": None}
        resolved = _resolve_mid(session.model)
        if not resolved.startswith("cc/"):
            options_kwargs["model"] = f"cc/{resolved}"
        logger.info("[MCP-DEBUG] Using 9Router (bare mode)")
    else:
        raise ValueError("No AI provider configured. Set an API key or connect a subscription.")

    if mcp_servers:
        options_kwargs["mcp_servers"] = mcp_servers
        mcp_json_len = len(json.dumps({"mcpServers": mcp_servers}))
        logger.info(f"[MCP-DEBUG] mcp_servers passed to SDK: {list(mcp_servers.keys())}, JSON length={mcp_json_len}")
    if composed_prompt:
        options_kwargs["system_prompt"] = composed_prompt
    if session.max_turns:
        options_kwargs["max_turns"] = session.max_turns
    if session.cwd:
        options_kwargs["cwd"] = session.cwd
    if session.sdk_session_id:
        options_kwargs["resume"] = session.sdk_session_id
        if fork_session:
            options_kwargs["fork_session"] = True

    logger.info(f"[MCP-DEBUG] Creating ClaudeAgentOptions with model={session.model}")
    return options_kwargs


def _compute_tool_permissions(
    session: AgentSession,
    builtin_perms: dict,
    mcp_servers: dict,
    browser_delegation_tools: list[str],
    invoke_agent_tools: list[str],
) -> tuple[list[str], list[str]]:
    effective_allowed = [
        t for t in session.allowed_tools
        if t in FULL_TOOLS and builtin_perms.get(t, "always_allow") == "always_allow"
    ]
    effective_disallowed = [
        t for t in FULL_TOOLS
        if builtin_perms.get(t, "always_allow") == "deny"
    ]

    if not mcp_servers:
        return effective_allowed, effective_disallowed

    all_tools_list = load_all_tools()
    for name in mcp_servers:
        if name == "openswarm-browser-agent":
            for bt in browser_delegation_tools:
                policy = builtin_perms.get(bt, "always_allow")
                if policy == "always_allow":
                    effective_allowed.append(f"mcp__openswarm-browser-agent__{bt}")
                elif policy == "deny":
                    effective_disallowed.append(f"mcp__openswarm-browser-agent__{bt}")
            continue
        if name == "openswarm-invoke-agent":
            for it in invoke_agent_tools:
                policy = builtin_perms.get(it, "always_allow")
                if policy == "always_allow":
                    effective_allowed.append(f"mcp__openswarm-invoke-agent__{it}")
                elif policy == "deny":
                    effective_disallowed.append(f"mcp__openswarm-invoke-agent__{it}")
            continue
        tool_def = next(
            (t for t in all_tools_list if t.mcp_config and t.enabled and _sanitize_server_name(t.name) == name),
            None,
        )
        if tool_def:
            denied = _get_denied_tool_names(tool_def)
            known = _get_all_known_tool_names(tool_def)
            for tn in known - denied:
                policy = tool_def.tool_permissions.get(tn, "ask")
                if policy == "always_allow":
                    effective_allowed.append(f"mcp__{name}__{tn}")
            for tn in denied:
                effective_disallowed.append(f"mcp__{name}__{tn}")
        else:
            effective_allowed.append(f"mcp__{name}__*")

    google_allowed = [t for t in effective_allowed if "google-workspace" in t]
    reddit_allowed = [t for t in effective_allowed if "reddit" in t]
    builtin_allowed = [t for t in effective_allowed if not t.startswith("mcp__")]
    logger.info(f"[MCP-DEBUG] effective_allowed: {len(effective_allowed)} total "
                f"(builtins={len(builtin_allowed)}, google={len(google_allowed)}, reddit={len(reddit_allowed)})")
    if effective_disallowed:
        logger.info(f"[MCP-DEBUG] effective_disallowed: {effective_disallowed}")

    return effective_allowed, effective_disallowed
