"""Direct coverage for register_builtin_mcp_servers: the always-on meta + settings-meta servers
are always registered, the browser/invoke delegation servers register unless their tools are
fully denied, and the delegation tool-name lists come back for the allowlist gate."""

import os

from backend.apps.agents.core.models import AgentSession
from backend.apps.agents.manager.register_builtin_mcp_servers import register_builtin_mcp_servers


def p_session():
    return AgentSession(name="t", model="sonnet", dashboard_id="d")


def test_registers_always_on_and_delegation_servers():
    mcp_servers = {}
    browser_tools, invoke_tools = register_builtin_mcp_servers(
        mcp_servers, p_session(), {}, None)
    # always-on
    assert "openswarm-mcp-meta" in mcp_servers
    assert "openswarm-settings-meta" in mcp_servers
    # delegation (not denied)
    assert "openswarm-browser-agent" in mcp_servers
    assert "openswarm-invoke-agent" in mcp_servers
    assert browser_tools == ["CreateBrowserAgent", "BrowserAgent", "BrowserAgents"]
    assert invoke_tools == ["InvokeAgent"]
    # Every registered server's script path must resolve to a file that ACTUALLY EXISTS. This is the assertion that catches a moved-caller resolving the wrong agents dir.
    for name in ("openswarm-mcp-meta", "openswarm-settings-meta",
                 "openswarm-browser-agent", "openswarm-invoke-agent"):
        script = mcp_servers[name]["args"][0]
        assert os.path.isfile(script), f"{name} script does not exist on disk: {script}"


def test_fully_denied_delegation_servers_are_not_registered():
    mcp_servers = {}
    perms = {t: "deny" for t in ("CreateBrowserAgent", "BrowserAgent", "BrowserAgents", "InvokeAgent")}
    register_builtin_mcp_servers(mcp_servers, p_session(), perms, None)
    assert "openswarm-browser-agent" not in mcp_servers   # all browser tools denied -> skip
    assert "openswarm-invoke-agent" not in mcp_servers
    assert "openswarm-mcp-meta" in mcp_servers             # always-on regardless
