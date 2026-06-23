"""Direct coverage for register_builtin_mcp_servers: the always-on meta + settings-meta servers
are always registered, the browser/invoke delegation servers register unless their tools are
fully denied, and the delegation tool-name lists come back for the allowlist gate."""

from backend.apps.agents.core.models import AgentSession
from backend.apps.agents.manager.builtin_mcp_servers import register_builtin_mcp_servers


def _session():
    return AgentSession(name="t", model="sonnet", dashboard_id="d")


def test_registers_always_on_and_delegation_servers():
    mcp_servers = {}
    browser_tools, invoke_tools = register_builtin_mcp_servers(
        mcp_servers, _session(), {}, None, "/agents")
    # always-on
    assert "openswarm-mcp-meta" in mcp_servers
    assert "openswarm-settings-meta" in mcp_servers
    # delegation (not denied)
    assert "openswarm-browser-agent" in mcp_servers
    assert "openswarm-invoke-agent" in mcp_servers
    assert browser_tools == ["CreateBrowserAgent", "BrowserAgent", "BrowserAgents"]
    assert invoke_tools == ["InvokeAgent"]
    # server scripts resolve under the passed agents dir
    assert mcp_servers["openswarm-mcp-meta"]["args"][0].startswith("/agents")


def test_fully_denied_delegation_servers_are_not_registered():
    mcp_servers = {}
    perms = {t: "deny" for t in ("CreateBrowserAgent", "BrowserAgent", "BrowserAgents", "InvokeAgent")}
    register_builtin_mcp_servers(mcp_servers, _session(), perms, None, "/agents")
    assert "openswarm-browser-agent" not in mcp_servers   # all browser tools denied -> skip
    assert "openswarm-invoke-agent" not in mcp_servers
    assert "openswarm-mcp-meta" in mcp_servers             # always-on regardless
