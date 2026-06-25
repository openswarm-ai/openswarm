"""'Always approve' persistence invariant.

The bug: the dispatch gate READ a tool's policy from one slot while the
'Always approve' button WROTE it to another (the raw mcp__server__action name
in builtin_permissions vs the parsed inner action on the owning tool), so the
next call never saw the policy and the button behaved like a one-time accept.

The seal: both sides now resolve the slot through resolve_policy_slot(), so a
WRITE always lands where the READ looks. These tests pin that for every
tool-name shape, including the round-trip that the old code failed.
"""

from backend.apps.tools_lib.tools_lib import resolve_policy_slot, PolicySlot
from backend.apps.tools_lib.mcp_config import sanitize_server_name
from backend.apps.tools_lib.models import ToolDefinition


def p_mcp_tool(name: str) -> ToolDefinition:
    return ToolDefinition(name=name, mcp_config={"command": "x"}, enabled=True, tool_permissions={})


def test_slot_for_builtin_tool():
    assert resolve_policy_slot("Bash", []) == PolicySlot("builtin", "Bash", None)
    assert resolve_policy_slot("Read", []) == PolicySlot("builtin", "Read", None)


def test_slot_for_our_browser_and_invoke_agents_uses_inner_name():
    # These live in builtin_permissions under the INNER name, not the namespaced one.
    assert resolve_policy_slot("mcp__openswarm-browser-agent__BrowserAgent", []) == \
        PolicySlot("builtin", "BrowserAgent", None)
    assert resolve_policy_slot("mcp__openswarm-invoke-agent__InvokeAgent", []) == \
        PolicySlot("builtin", "InvokeAgent", None)


def test_slot_for_community_mcp_points_at_the_owning_tool():
    tool = p_mcp_tool("My Notion Server")
    slug = sanitize_server_name(tool.name)
    assert resolve_policy_slot(f"mcp__{slug}__notion-fetch", [tool]) == \
        PolicySlot("mcp", tool.id, "notion-fetch")


def test_slot_for_unknown_mcp_has_no_write_target():
    assert resolve_policy_slot("mcp__ghostserver__do-thing", []) == \
        PolicySlot("mcp", None, "do-thing")


# read/write mirror the dispatch-gate branches in agent_manager (effective_policy / set_tool_policy): both key through resolve_policy_slot.
def p_read(tool_name, builtin_perms, tools):
    slot = resolve_policy_slot(tool_name, tools)
    if slot.store == "builtin":
        return builtin_perms.get(slot.key, "ask")
    if slot.key is not None:
        for t in tools:
            if t.id == slot.key:
                return t.tool_permissions.get(slot.action, "ask")
    return "ask"


def p_write(tool_name, policy, builtin_perms, tools):
    slot = resolve_policy_slot(tool_name, tools)
    if slot.store == "builtin":
        builtin_perms[slot.key] = policy
        return
    if slot.key is not None:
        for t in tools:
            if t.id == slot.key:
                t.tool_permissions[slot.action] = policy
                return


def test_always_approve_round_trips_for_every_tool_shape():
    """The invariant the old code violated: after WRITE(always_allow), the very
    next READ returns always_allow, for builtin, our agents, and community MCP."""
    notion = p_mcp_tool("Notion")
    slug = sanitize_server_name("Notion")
    tools = [notion]
    builtin_perms: dict[str, str] = {}

    shapes = [
        "Bash",
        "Read",
        "mcp__openswarm-browser-agent__BrowserAgent",
        "mcp__openswarm-invoke-agent__InvokeAgent",
        f"mcp__{slug}__notion-fetch",
    ]
    for tool_name in shapes:
        assert p_read(tool_name, builtin_perms, tools) != "always_allow"
        p_write(tool_name, "always_allow", builtin_perms, tools)
        assert p_read(tool_name, builtin_perms, tools) == "always_allow", \
            f"{tool_name}: write did not land in the slot the gate reads"


def test_two_actions_on_the_same_mcp_server_are_independent():
    """Approving one action must not silently approve a sibling action."""
    tool = p_mcp_tool("Notion")
    slug = sanitize_server_name("Notion")
    tools = [tool]
    bp: dict[str, str] = {}
    p_write(f"mcp__{slug}__notion-fetch", "always_allow", bp, tools)
    assert p_read(f"mcp__{slug}__notion-fetch", bp, tools) == "always_allow"
    assert p_read(f"mcp__{slug}__notion-create-pages", bp, tools) == "ask"


# ---- Integration: the same round-trip through the REAL file persistence the gate uses (load_builtin_permissions / _save / _load_all), so 'write then re-read' survives a save+reload, not just an in-memory dict. ----
import backend.apps.tools_lib.tools_lib as tl


def test_builtin_policy_survives_a_real_file_reload(tmp_path, monkeypatch):
    monkeypatch.setattr(tl, "BUILTIN_PERMS_PATH", str(tmp_path / "builtin_permissions.json"))
    slot = tl.resolve_policy_slot("Read", [])
    perms = tl.load_builtin_permissions()
    perms[slot.key] = "always_allow"
    tl.save_builtin_permissions(perms)
    # Fresh read (what the next session / a reload does) finds it at the read key.
    reloaded = tl.load_builtin_permissions()
    assert reloaded.get(tl.resolve_policy_slot("Read", []).key) == "always_allow"


def test_mcp_policy_survives_a_real_tool_file_reload(tmp_path, monkeypatch):
    monkeypatch.setattr(tl, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(tl, "p_tools_cache", None)
    monkeypatch.setattr(tl, "p_tools_cache_sig", None)
    tl.save(p_mcp_tool("Notion"))
    slug = sanitize_server_name("Notion")
    name = f"mcp__{slug}__notion-fetch"

    # WRITE via the resolver against the freshly loaded tool, then persist.
    tools = tl.load_all_tools()
    slot = tl.resolve_policy_slot(name, tools)
    target = next(t for t in tools if t.id == slot.key)
    target.tool_permissions[slot.action] = "always_allow"
    tl.save(target)

    # RELOAD from disk and read via the resolver: the policy is there.
    tools2 = tl.load_all_tools()
    rslot = tl.resolve_policy_slot(name, tools2)
    got = next(t for t in tools2 if t.id == rslot.key)
    assert got.tool_permissions.get(rslot.action) == "always_allow"
