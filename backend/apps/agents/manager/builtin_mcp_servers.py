"""Register the always-on + delegation MCP servers (browser-agent, invoke-agent, meta,
settings-meta) into the per-turn mcp_servers map. Lifted out of the agent loop; the server
scripts live beside agent_manager.py, so the loop passes their directory in. Returns the
browser/invoke delegation tool-name lists the allowlist gate needs."""

import os
import sys
from typing import Dict, List, Optional, Tuple

from typeguard import typechecked

from backend.apps.agents.core.models import AgentSession
from backend.auth import get_auth_token


@typechecked
def register_builtin_mcp_servers(
    mcp_servers: Dict,
    session: AgentSession,
    builtin_perms: Dict[str, str],
    selected_browser_ids: Optional[List[str]],
    agents_dir: str,
) -> Tuple[List[str], List[str]]:
    browser_delegation_tools = ["CreateBrowserAgent", "BrowserAgent", "BrowserAgents"]
    browser_all_denied = all(
        builtin_perms.get(t, "always_allow") == "deny"
        for t in browser_delegation_tools
    )

    if not browser_all_denied:
        browser_agent_server_path = os.path.join(
            agents_dir, "browser_agent_mcp_server.py"
        )
        backend_port = os.environ.get("OPENSWARM_PORT", "8324")
        # Only the card the user actually picked in select-mode gets claimed for the
        # task, so the sub drives that one instead of opening its own duplicate. Passing
        # EVERY dashboard card here (the old behavior) made the sub force-grab a random,
        # usually-parked card and never navigate it, which broke the bulk of browser tasks.
        pre_selected_bids = [b for b in (selected_browser_ids or []) if b]
        auth_tok = get_auth_token()
        mcp_servers["openswarm-browser-agent"] = {
            "command": sys.executable,
            "args": [browser_agent_server_path],
            "env": {
                "OPENSWARM_PORT": backend_port,
                "OPENSWARM_AUTH_TOKEN": auth_tok,
                "OPENSWARM_AGENT_MODEL": session.model,
                "OPENSWARM_DASHBOARD_ID": session.dashboard_id or "",
                "OPENSWARM_PRE_SELECTED_BROWSER_IDS": ",".join(pre_selected_bids),
                "OPENSWARM_PARENT_SESSION_ID": session.id,
            },
            "type": "stdio",
        }

    invoke_agent_tools = ["InvokeAgent"]
    invoke_all_denied = all(
        builtin_perms.get(t, "always_allow") == "deny"
        for t in invoke_agent_tools
    )

    if not invoke_all_denied:
        invoke_agent_server_path = os.path.join(
            agents_dir, "invoke_agent_mcp_server.py"
        )
        backend_port = os.environ.get("OPENSWARM_PORT", "8324")
        mcp_servers["openswarm-invoke-agent"] = {
            "command": sys.executable,
            "args": [invoke_agent_server_path],
            "env": {
                "OPENSWARM_PORT": backend_port,
                "OPENSWARM_AUTH_TOKEN": get_auth_token(),
                "OPENSWARM_PARENT_SESSION_ID": session.id,
                "OPENSWARM_DASHBOARD_ID": session.dashboard_id or "",
            },
            "type": "stdio",
        }

    # Always-on meta-MCP server. Exposes MCPList / MCPSearch /
    # MCPActivate so the model can discover and activate user MCPs at
    # runtime. The activation gate (active_mcps filter in
    # p_build_mcp_servers above) ensures the model cannot reach any
    # other MCP server's tools without going through this layer first.
    mcp_meta_server_path = os.path.join(
        agents_dir, "mcp_meta_server.py"
    )
    mcp_servers["openswarm-mcp-meta"] = {
        "command": sys.executable,
        "args": [mcp_meta_server_path],
        "env": {
            "OPENSWARM_PORT": os.environ.get("OPENSWARM_PORT", "8324"),
            "OPENSWARM_AUTH_TOKEN": get_auth_token(),
            "OPENSWARM_PARENT_SESSION_ID": session.id,
        },
        "type": "stdio",
    }

    # Always-on settings-meta server: SettingsRead / SettingsWrite let the
    # agent read and edit its own OpenSwarm Settings autonomously. The
    # backend (/api/settings-meta) enforces the only two guardrails: it
    # can't disconnect the credential powering this run, and reads come
    # back with secrets redacted. No activation gate, Settings is the
    # agent's own house, not a third-party MCP.
    settings_meta_server_path = os.path.join(
        agents_dir, "settings_meta_server.py"
    )
    mcp_servers["openswarm-settings-meta"] = {
        "command": sys.executable,
        "args": [settings_meta_server_path],
        "env": {
            "OPENSWARM_PORT": os.environ.get("OPENSWARM_PORT", "8324"),
            "OPENSWARM_AUTH_TOKEN": get_auth_token(),
            "OPENSWARM_PARENT_SESSION_ID": session.id,
        },
        "type": "stdio",
    }
    return browser_delegation_tools, invoke_agent_tools
