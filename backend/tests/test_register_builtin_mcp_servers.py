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
        mcp_servers, p_session(), {}, None, None)
    # always-on: the three ungated meta servers ride ONE combined process now (ENG-208)
    assert "openswarm-core" in mcp_servers
    assert "openswarm-mcp-meta" not in mcp_servers
    assert "openswarm-settings-meta" not in mcp_servers
    assert "openswarm-apps" not in mcp_servers
    # delegation (not denied) rides the combined process as module flags
    mods = mcp_servers["openswarm-core"]["env"]["OSW_MCP_MODULES"].split(",")
    assert "browser" in mods and "invoke" in mods
    assert browser_tools == ["CreateBrowserAgent", "BrowserAgent", "BrowserAgents", "AppAgent"]
    # Exact equality on purpose: this is where a silently widened tool surface gets caught.
    # ReadAgentWork joined so a parent can read a child's work off our record instead of
    # asking the child model to say it again (ENG-389); it inherits InvokeAgent's policy.
    assert invoke_tools == ["InvokeAgent", "ReadAgentWork"]
    # Every registered server's script path must resolve to a file that ACTUALLY EXISTS. This is the assertion that catches a moved-caller resolving the wrong agents dir.
    script = mcp_servers["openswarm-core"]["args"][0]
    assert os.path.isfile(script), f"combined server script does not exist on disk: {script}"


def test_fully_denied_delegation_servers_are_not_registered():
    mcp_servers = {}
    perms = {t: "deny" for t in ("CreateBrowserAgent", "BrowserAgent", "BrowserAgents", "AppAgent", "InvokeAgent")}
    register_builtin_mcp_servers(mcp_servers, p_session(), perms, None, None)
    mods = mcp_servers["openswarm-core"]["env"]["OSW_MCP_MODULES"].split(",")
    assert "browser" not in mods and "invoke" not in mods  # all denied -> module skipped
    assert "meta" in mods and "apps" in mods               # always-on regardless
