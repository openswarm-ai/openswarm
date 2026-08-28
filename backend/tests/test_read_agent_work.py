"""ENG-389: a parent reads a child's work off our own record instead of asking the child model to
say it again.

The class this closes is not a wording bug. Asking a model to restate its prior output IS a
reproduction request, on a lane whose filter looks for exactly that; delegation-bearing chats block
at 13.0% against a 2.7% baseline. `defuse_extraction_ask` lowers the rate and cannot close the
class, because the 4th real blocked prompt was already well-worded ("Quick handoff: what project
were you working on... Summarize the build plan you landed on"). The fix is that the prompt is
never written."""

import json

from backend.apps.agents import invoke_agent_mcp_server as inv
from backend.apps.agents.core.models import AgentSession, Message
from backend.apps.agents.manager.session.history_compaction import (
    get_branch_messages,
    render_agent_trail,
)

P_TOOL_NAMES = [t["name"] for t in inv.TOOLS]


def p_session() -> AgentSession:
    s = AgentSession(id="child1", name="Build agent", status="completed")
    s.messages = [
        Message(role="user", content="Port the exporter to the new schema", branch_id="main"),
        Message(role="tool_call", content={"tool": "Bash", "input": {"command": "pytest backend/tests"}}, branch_id="main"),
        Message(role="tool_result", content={"tool_name": "Bash", "text": "3 failed, 20 passed"}, branch_id="main"),
        Message(role="assistant", content="Three tests fail on the date column; I stopped there.", branch_id="main"),
    ]
    return s


def test_the_tool_exists_and_is_the_one_the_description_points_at():
    assert "ReadAgentWork" in P_TOOL_NAMES
    invoke = next(t for t in inv.TOOLS if t["name"] == "InvokeAgent")
    assert "ReadAgentWork" in invoke["description"], "InvokeAgent must name the read tool as the alternative"


def test_invoke_agent_no_longer_teaches_the_extraction_ask():
    """The tool description used to say 'query another agent about its prior work', which is the
    exact shape the filter refuses. A tool that teaches the bad prompt makes every wording gate
    downstream a losing game."""
    d = next(t for t in inv.TOOLS if t["name"] == "InvokeAgent")["description"].lower()
    assert "query another agent about its prior work" not in d
    for shape in ("restate", "reproduce", "verbatim", "say it again", "repeat what"):
        assert shape not in d, f"InvokeAgent's description still asks a model to {shape}"


def test_no_delegation_prompt_anywhere_asks_a_model_to_restate_its_output():
    """The issue's acceptance criterion, as a grep with teeth. It reads the delegation sources
    rather than one function, because the shape only has to survive in ONE of them to keep the
    class alive."""
    p_files = [
        "backend/apps/agents/invoke_agent_mcp_server.py",
        "backend/apps/agents/spawn_agent_mcp_server.py",
        "backend/apps/agents/manager/AgentLaunch.py",
    ]
    p_bad = ("verbatim", "word for word", "word-for-word", "exactly as you", "repeat what you",
             "restate your", "reproduce your", "dump of your")
    for path in p_files:
        body = open(path, encoding="utf-8").read().lower()
        for shape in p_bad:
            assert shape not in body, f"{path} still carries an extraction-shaped phrase: {shape!r}"


def test_the_work_it_returns_is_the_trail_we_already_store():
    """Reused, not reinvented: what is safe to send another model has one definition, shared with
    the session recap and the workflow transcript."""
    s = p_session()
    trail = render_agent_trail(get_branch_messages(s))
    assert "Port the exporter" in trail
    assert "pytest backend/tests" in trail, "the tool trail is the point; it must survive"
    assert "3 failed, 20 passed" in trail
    assert "Three tests fail on the date column" in trail, "the run's own outcome must come home"


def test_it_never_emits_a_role_tagged_replay():
    """The shape ENG-358 removed from the recap and ENG-396 found in two more renderers. A third
    door for it is how the class comes back."""
    trail = render_agent_trail(get_branch_messages(p_session()))
    for line in trail.splitlines():
        assert not line.lstrip().startswith(("USER:", "ASSISTANT:", "User:", "Assistant:"))


def test_a_missing_session_is_an_error_not_an_empty_success():
    """A read that quietly returns nothing reads to a model as 'that agent did nothing', which is a
    lying status, not a missing one."""
    out = inv.handle_read_agent_work({"session_id": ""})
    assert out.get("isError") and "session_id is required" in out["content"][0]["text"]


def test_a_session_with_no_work_says_so_rather_than_looking_empty():
    inv.read_work = lambda sid: {"session_id": sid, "name": "Idle", "status": "completed", "work": ""}
    out = inv.handle_read_agent_work({"session_id": "x"})
    assert not out.get("isError")
    assert "has not done any work yet" in out["content"][0]["text"]


def test_read_agent_work_inherits_a_denied_invoke_policy():
    """Never widen a tool surface silently: a user who denied delegation denied this too, unless
    they say otherwise."""
    from backend.apps.agents.manager.register_builtin_mcp_servers import register_builtin_mcp_servers
    s = p_session()
    perms = {"InvokeAgent": "deny"}
    servers = {}
    register_builtin_mcp_servers(servers, s, perms, None, None)
    assert perms["ReadAgentWork"] == "deny"
    mods = servers["openswarm-core"]["env"]["OSW_MCP_MODULES"].split(",")
    assert "invoke" not in mods, "denying InvokeAgent must not leave the module loaded for the read tool"


def test_it_is_reachable_by_default():
    """The liveness half: a guard that never fires and a tool nobody can call look identical."""
    from backend.apps.agents.manager.register_builtin_mcp_servers import register_builtin_mcp_servers
    servers = {}
    perms = {}
    register_builtin_mcp_servers(servers, p_session(), perms, None, None)
    assert "invoke" in servers["openswarm-core"]["env"]["OSW_MCP_MODULES"].split(",")
    assert perms["ReadAgentWork"] == "always_allow"
