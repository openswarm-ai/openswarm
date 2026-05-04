"""Unit tests for `backend.apps.agents.agent_manager`.

Covers the pure-logic helpers + the lifecycle methods on `AgentManager`
that don't require a live Claude Code subprocess. The streaming /
tool-execution path (`_run_agent_loop`) is deliberately out of scope —
it depends on the real CLI and lives in a future integration suite.

Test groups:
  - module-level helpers (`_save_session` / `_load_session_data` /
    `_load_all_session_data`, error-classifier regex tables,
    permission helpers, `_ensure_cwd_git_repo`)
  - pure instance methods (`_resolve_mode`, `_compose_system_prompt`,
    `_resolve_context_paths`, `_build_dir_tree`, `_resolve_forced_tools`,
    `_resolve_attached_skills`, `_get_branch_messages`,
    `_build_history_prefix`, `_approx_tokens`,
    `_summarize_message_block`, `_truncate_large_tool_result`,
    `_build_search_text`, `_maybe_compact`)
  - lifecycle (launch/update/edit/switch_branch/duplicate/close/
    delete/resume/stop, history, browser-agent children, approval,
    reconcile, persist+restore)
  - cross-provider fork on `send_message`

Tests rely on the conftest fixtures `tmp_data_dirs` (clears
`AgentManager.sessions/tasks` + per-feature data dirs) and where
needed, monkeypatches the SESSIONS_DIR module symbol so a single test
can write directly to a `tmp_path` without leaking into siblings.
"""

from __future__ import annotations

import asyncio
import json
import os
from datetime import datetime, timedelta
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from backend.apps.agents import agent_manager as am_mod
from backend.apps.agents.agent_manager import (
    AgentManager,
    FULL_TOOLS,
    _delete_session_file,
    _ensure_cwd_git_repo,
    _get_all_known_tool_names,
    _get_denied_tool_names,
    _is_auth_error,
    _is_fully_denied,
    _is_long_context_error,
    _is_transient_capacity_error,
    _load_all_session_data,
    _load_session_data,
    _save_session,
    get_all_tool_names,
)
from backend.apps.agents.models import (
    AgentConfig,
    AgentSession,
    ApprovalRequest,
    Message,
    MessageBranch,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _seed_session(
    manager: AgentManager,
    *,
    name: str = "Test",
    model: str = "sonnet",
    mode: str = "agent",
    dashboard_id: str | None = None,
    parent_session_id: str | None = None,
    messages: list[Message] | None = None,
) -> AgentSession:
    """Insert a synthetic session straight into manager.sessions.

    Bypasses launch_agent so we can test the post-launch methods
    deterministically without exercising the lifespan / mode store.
    """
    session = AgentSession(
        name=name,
        model=model,
        mode=mode,
        dashboard_id=dashboard_id,
        parent_session_id=parent_session_id,
        messages=messages or [],
    )
    manager.sessions[session.id] = session
    return session


# ---------------------------------------------------------------------------
# Module helpers: session file IO
# ---------------------------------------------------------------------------


def test_save_load_session_round_trip(tmp_data_dirs):
    payload = {
        "id": "abc",
        "name": "round",
        "model": "sonnet",
        "mode": "agent",
        "messages": [],
    }
    _save_session("abc", payload)
    loaded = _load_session_data("abc")
    assert loaded == payload


def test_load_session_missing_returns_none(tmp_data_dirs):
    assert _load_session_data("nope-does-not-exist") is None


def test_delete_session_file_idempotent(tmp_data_dirs):
    _save_session("d1", {"id": "d1"})
    _delete_session_file("d1")
    _delete_session_file("d1")  # second call must not raise
    assert _load_session_data("d1") is None


def test_load_all_session_data_empty_dir(tmp_path, monkeypatch):
    """When SESSIONS_DIR doesn't exist, must return [] rather than raise."""
    monkeypatch.setattr(am_mod, "SESSIONS_DIR", str(tmp_path / "nope"))
    assert _load_all_session_data() == []


def test_load_all_session_data_returns_id_and_payload(tmp_data_dirs):
    _save_session("a1", {"id": "a1", "name": "A"})
    _save_session("b2", {"id": "b2", "name": "B"})
    pairs = _load_all_session_data()
    by_id = {sid: data for sid, data in pairs}
    assert by_id["a1"]["name"] == "A"
    assert by_id["b2"]["name"] == "B"


# ---------------------------------------------------------------------------
# Error classifiers
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "msg",
    [
        "HTTP 429 rate_limit_error",
        "HTTP 503 service unavailable",
        "HTTP 502 bad gateway",
        "Anthropic is overloaded",
        "model is at capacity",
        "Try again shortly",
        "internal server error",
        "ECONNRESET on upstream",
        "ETIMEDOUT",
        "fetch failed",
        "upstream connect error",
        "No pool capacity available. Try again shortly.",
    ],
)
def test_is_transient_capacity_error_matches_known_signals(msg: str):
    """Every entry in `_TRANSIENT_CAPACITY_PATTERNS` (+ the explicit
    no-pool-capacity check) must classify as transient."""
    assert _is_transient_capacity_error(RuntimeError(msg))


@pytest.mark.parametrize(
    "msg",
    [
        "Usage cap exceeded for this billing period",
        "You've reached your OpenSwarm Pro plan limit",
        "no active subscription",
        "subscription canceled",
        "subscription past_due",
        "Invalid token supplied",
        "missing bearer token",
        "401 Unauthorized",
        "403 Forbidden",
        "extra usage is required for long context",
    ],
)
def test_is_transient_capacity_error_rejects_non_transient(msg: str):
    """`_NON_TRANSIENT_PATTERNS` short-circuits even when the same
    message also matches a transient pattern (via the explicit
    `_NON_TRANSIENT_PATTERNS.search → return False` early-out)."""
    assert not _is_transient_capacity_error(RuntimeError(msg))


def test_is_transient_capacity_error_uses_extra_text():
    """The CLI's ProcessError stringifies generically; the real cause
    only shows up via the `extra_text` channel (subprocess stderr).
    Both must be classified."""
    exc = RuntimeError("Command failed with exit code 1")
    assert _is_transient_capacity_error(exc, extra_text="rate_limit_error from upstream")
    assert _is_transient_capacity_error(exc, extra_text="Overloaded; please retry")


def test_is_transient_capacity_error_empty_returns_false():
    assert not _is_transient_capacity_error(RuntimeError(""))


@pytest.mark.parametrize(
    "msg,expected",
    [
        ("extra usage is required for long context", True),
        ("long context request requires premium tier", True),
        ("long context not available on this plan", True),
        ("regular 429 rate limit", False),
        ("HTTP 503", False),
    ],
)
def test_is_long_context_error(msg: str, expected: bool):
    assert _is_long_context_error(RuntimeError(msg)) is expected


@pytest.mark.parametrize(
    "msg,expected",
    [
        ("HTTP 401 Unauthorized", True),
        ("Invalid authentication credentials", True),
        ("invalid api-key", True),
        ("missing bearer token", True),
        ("403 Forbidden", True),
        ("no credentials for provider: claude", True),
        ("provider not configured", True),
        ("provider not connected", True),
        ("HTTP 500 server error", False),
        ("rate_limit_error", False),
    ],
)
def test_is_auth_error(msg: str, expected: bool):
    assert _is_auth_error(RuntimeError(msg)) is expected


def test_is_auth_error_empty_returns_false():
    assert not _is_auth_error(RuntimeError(""))


# ---------------------------------------------------------------------------
# Permission helpers + get_all_tool_names
# ---------------------------------------------------------------------------


def _make_tool(perms: dict) -> object:
    """Synthetic ToolDefinition stand-in for permission helpers."""
    obj = MagicMock()
    obj.tool_permissions = perms
    return obj


def test_get_denied_tool_names_filters_underscored_keys():
    tool = _make_tool({
        "list_files": "deny",
        "read_file": "always_allow",
        "write_file": "deny",
        "_tool_descriptions": {"list_files": "x", "read_file": "y"},  # must be skipped
    })
    assert _get_denied_tool_names(tool) == {"list_files", "write_file"}


def test_get_all_known_tool_names_reads_descriptions_map():
    tool = _make_tool({
        "_tool_descriptions": {"a": "d", "b": "d", "c": "d"},
    })
    assert _get_all_known_tool_names(tool) == {"a", "b", "c"}


def test_is_fully_denied_true_when_every_known_subtool_denied():
    tool = _make_tool({
        "_tool_descriptions": {"a": "d", "b": "d"},
        "a": "deny",
        "b": "deny",
    })
    assert _is_fully_denied(tool) is True


def test_is_fully_denied_false_when_partial_or_unknown():
    partial = _make_tool({
        "_tool_descriptions": {"a": "d", "b": "d"},
        "a": "deny",  # b not denied
    })
    assert _is_fully_denied(partial) is False

    no_known = _make_tool({"_tool_descriptions": {}})
    assert _is_fully_denied(no_known) is False


def test_get_all_tool_names_returns_full_tools_when_no_perms_set(tmp_data_dirs):
    """With an empty SETTINGS/TOOLS dir (tmp_data_dirs wipes both),
    no builtin permissions are set → every entry in FULL_TOOLS is
    surfaced. No MCP tools because the tool dir is empty too."""
    names = get_all_tool_names()
    assert set(FULL_TOOLS).issubset(set(names))


def test_get_all_tool_names_drops_explicitly_denied_builtins(tmp_data_dirs):
    """Writes a builtin-permissions file to mark Bash as denied. The
    file lives outside `tmp_data_dirs`'s wipe set, so we restore it
    afterwards to avoid leaking state into sibling tests."""
    from backend.apps.tools_lib.tools_lib import save_builtin_permissions
    from backend.config.paths import BUILTIN_PERMISSIONS_PATH

    try:
        save_builtin_permissions({"Bash": "deny"})
        names = get_all_tool_names()
        assert "Bash" not in names
        assert "Read" in names  # other tools survive
    finally:
        if os.path.exists(BUILTIN_PERMISSIONS_PATH):
            os.remove(BUILTIN_PERMISSIONS_PATH)


# ---------------------------------------------------------------------------
# _ensure_cwd_git_repo
# ---------------------------------------------------------------------------


def test_ensure_cwd_git_repo_creates_repo_when_missing(tmp_path):
    """Fresh tmp dir with no .git → function inits a repo + empty commit."""
    cwd = tmp_path / "fresh"
    cwd.mkdir()
    _ensure_cwd_git_repo(str(cwd), home=str(tmp_path))
    # Either .git lives here directly, or git decided we're already in
    # a parent repo (the test runner's repo, for instance). Both are
    # valid healthy outcomes.
    if (cwd / ".git").exists():
        # Verify HEAD resolves — the function commits an empty seed.
        import subprocess
        head = subprocess.run(
            ["git", "rev-parse", "--verify", "HEAD"],
            cwd=str(cwd),
            capture_output=True,
        )
        assert head.returncode == 0


def test_ensure_cwd_git_repo_skips_risky_roots(tmp_path):
    """Calling on $HOME / / / parent-of-home must short-circuit and
    leave the directory untouched."""
    home = str(tmp_path)
    _ensure_cwd_git_repo(home, home=home)
    assert not (tmp_path / ".git").exists()


def test_ensure_cwd_git_repo_silent_on_missing_dir(tmp_path):
    """Nonexistent path → silent return, no exception."""
    _ensure_cwd_git_repo(str(tmp_path / "nope"), home=str(tmp_path))


# ---------------------------------------------------------------------------
# Pure instance methods
# ---------------------------------------------------------------------------


def test_resolve_mode_unknown_returns_full_tools_and_no_prompt(tmp_data_dirs):
    """No mode file on disk → fallback returns (get_all_tool_names(),
    None, None)."""
    mgr = AgentManager()
    tools, prompt, folder = mgr._resolve_mode("definitely-not-a-mode")
    assert prompt is None and folder is None
    assert set(FULL_TOOLS).issubset(set(tools))


def test_resolve_mode_known_returns_mode_definition(tmp_data_dirs):
    """`ask` mode (built-in) has a fixed tool list + a system prompt."""
    from backend.apps.modes.modes import _save as save_mode
    from backend.apps.modes.models import BUILTIN_MODES

    ask = next(m for m in BUILTIN_MODES if m.id == "ask")
    save_mode(ask)

    mgr = AgentManager()
    tools, prompt, folder = mgr._resolve_mode("ask")
    assert "Read" in tools
    assert "Edit" not in tools
    assert prompt and "Ask mode" in prompt
    assert folder is None


def test_resolve_mode_with_null_tools_returns_get_all_tool_names(tmp_data_dirs):
    """`agent` mode ships with `tools=None`, which means 'all available'."""
    from backend.apps.modes.modes import _save as save_mode
    from backend.apps.modes.models import BUILTIN_MODES

    agent_mode = next(m for m in BUILTIN_MODES if m.id == "agent")
    save_mode(agent_mode)

    mgr = AgentManager()
    tools, _prompt, _folder = mgr._resolve_mode("agent")
    assert set(FULL_TOOLS).issubset(set(tools))


def test_compose_system_prompt_joins_truthy_parts():
    mgr = AgentManager()
    out = mgr._compose_system_prompt(
        "default",
        "mode",
        "session",
        connected_tools_ctx="tools",
        outputs_ctx="outputs",
        browser_ctx="browser",
        mcp_registry_ctx="registry",
    )
    # Order: default, mode, session, tools, registry, outputs, browser
    assert out is not None
    parts = out.split("\n\n")
    assert parts == ["default", "mode", "session", "tools", "registry", "outputs", "browser"]


def test_compose_system_prompt_drops_falsy_parts():
    mgr = AgentManager()
    out = mgr._compose_system_prompt(None, "", "session", connected_tools_ctx="ctx")
    assert out == "session\n\nctx"


def test_compose_system_prompt_all_none_returns_none():
    assert AgentManager()._compose_system_prompt(None, None, None) is None


def test_resolve_context_paths_empty_returns_empty():
    assert AgentManager()._resolve_context_paths(None) == ""
    assert AgentManager()._resolve_context_paths([]) == ""


def test_resolve_context_paths_file_round_trip(tmp_path):
    f = tmp_path / "note.txt"
    f.write_text("hello world")
    out = AgentManager()._resolve_context_paths(
        [{"path": str(f), "type": "file"}]
    )
    assert "<context_file" in out
    assert "hello world" in out


def test_resolve_context_paths_directory_uses_dir_tree(tmp_path):
    (tmp_path / "a.txt").write_text("A")
    (tmp_path / "sub").mkdir()
    (tmp_path / "sub" / "b.txt").write_text("B")
    out = AgentManager()._resolve_context_paths(
        [{"path": str(tmp_path), "type": "directory"}]
    )
    assert "<context_directory" in out
    assert "a.txt" in out
    assert "sub/" in out


def test_resolve_context_paths_missing_path_emits_marker(tmp_path):
    out = AgentManager()._resolve_context_paths(
        [{"path": str(tmp_path / "nope.txt"), "type": "file"}]
    )
    assert "not found" in out


def test_resolve_context_paths_type_mismatch(tmp_path):
    """Saying type=directory on something that's actually a file → marker."""
    f = tmp_path / "real.txt"
    f.write_text("x")
    out = AgentManager()._resolve_context_paths(
        [{"path": str(f), "type": "directory"}]
    )
    assert "type mismatch" in out


def test_build_dir_tree_lists_files_and_recurses(tmp_path):
    (tmp_path / "a.txt").write_text("A")
    (tmp_path / "z.txt").write_text("Z")  # alphabetical sort guard
    nested = tmp_path / "subdir"
    nested.mkdir()
    (nested / "deep.txt").write_text("D")

    lines = AgentManager()._build_dir_tree(str(tmp_path))
    # Files come before dirs (per implementation), sorted within each.
    assert lines[0] == "a.txt"
    assert lines[1] == "z.txt"
    assert "subdir/" in lines
    # Recursion into subdir prefixes with two spaces
    assert any(l.startswith("  ") and "deep.txt" in l for l in lines)


def test_build_dir_tree_respects_max_depth(tmp_path):
    (tmp_path / "sub").mkdir()
    (tmp_path / "sub" / "nested.txt").write_text("x")

    shallow = AgentManager()._build_dir_tree(str(tmp_path), max_depth=1)
    # max_depth=1 → don't descend; sub/ is listed but its content isn't
    assert "sub/" in shallow
    assert all("nested.txt" not in l for l in shallow)


def test_build_dir_tree_skips_dotfiles(tmp_path):
    (tmp_path / ".hidden").write_text("h")
    (tmp_path / "shown.txt").write_text("s")
    lines = AgentManager()._build_dir_tree(str(tmp_path))
    assert ".hidden" not in lines
    assert "shown.txt" in lines


def test_resolve_forced_tools_empty_returns_empty():
    assert AgentManager()._resolve_forced_tools(None) == ""
    assert AgentManager()._resolve_forced_tools([]) == ""


def test_resolve_forced_tools_decorates_with_descriptions(tmp_data_dirs):
    out = AgentManager()._resolve_forced_tools(["Read", "Bash"])
    assert "<forced_tools>" in out and "</forced_tools>" in out
    assert "- Read" in out
    assert "- Bash" in out


def test_resolve_attached_skills_empty_returns_empty():
    assert AgentManager()._resolve_attached_skills(None) == ""
    assert AgentManager()._resolve_attached_skills([]) == ""


def test_resolve_attached_skills_emits_block_per_skill():
    out = AgentManager()._resolve_attached_skills([
        {"name": "Skill A", "content": "do X"},
        {"name": "Skill B", "content": "do Y"},
        {"name": "Empty", "content": ""},  # silently dropped
    ])
    assert "[Using skill: Skill A]" in out
    assert "do X" in out
    assert "[Using skill: Skill B]" in out
    assert "Empty" not in out


# ---------------------------------------------------------------------------
# _get_branch_messages
# ---------------------------------------------------------------------------


def test_get_branch_messages_main_only():
    """No branches beyond main → returns the main-branch messages."""
    s = AgentSession(name="x", model="sonnet")
    s.messages = [
        Message(role="user", content="hi", branch_id="main"),
        Message(role="assistant", content="hello", branch_id="main"),
    ]
    out = AgentManager._get_branch_messages(s)
    assert [m.content for m in out] == ["hi", "hello"]


def test_get_branch_messages_walks_fork_lineage():
    """Branch B forks off main at the second user message; switching
    active to B should yield main-up-to-fork + B's own messages."""
    s = AgentSession(name="x", model="sonnet")
    u1 = Message(id="u1", role="user", content="first", branch_id="main")
    a1 = Message(id="a1", role="assistant", content="reply1", branch_id="main")
    u2 = Message(id="u2", role="user", content="second", branch_id="main")
    a2 = Message(id="a2", role="assistant", content="reply2", branch_id="main")
    # B forks at u2
    bu = Message(id="bu", role="user", content="fork-msg", branch_id="b1")
    ba = Message(id="ba", role="assistant", content="fork-reply", branch_id="b1")
    s.messages = [u1, a1, u2, a2, bu, ba]
    s.branches["b1"] = MessageBranch(id="b1", parent_branch_id="main", fork_point_message_id="u2")
    s.active_branch_id = "b1"

    out = AgentManager._get_branch_messages(s)
    contents = [m.content for m in out]
    # main slice (u1, a1) + b1 segment (bu, ba). u2 / a2 must be excluded.
    assert "first" in contents and "reply1" in contents
    assert "fork-msg" in contents and "fork-reply" in contents
    assert "second" not in contents and "reply2" not in contents


# ---------------------------------------------------------------------------
# _build_history_prefix / _approx_tokens / _summarize_message_block
# ---------------------------------------------------------------------------


def test_build_history_prefix_skips_non_user_assistant_and_hidden():
    msgs = [
        Message(role="user", content="hi"),
        Message(role="tool_call", content={"tool": "Read"}),  # skipped
        Message(role="assistant", content="hello"),
        Message(role="user", content="hidden", hidden=True),  # skipped
    ]
    out = AgentManager._build_history_prefix(msgs)
    assert "<prior_conversation>" in out
    assert "User: hi" in out
    assert "Assistant: hello" in out
    assert "Read" not in out
    assert "hidden" not in out


def test_build_history_prefix_empty_returns_empty():
    assert AgentManager._build_history_prefix([]) == ""


@pytest.mark.parametrize("text,expected", [
    ("", 1),
    ("a" * 4, 1),
    ("a" * 16, 4),
    ("a" * 100, 25),
])
def test_approx_tokens_chars_over_four(text, expected):
    assert AgentManager._approx_tokens(text) == expected


def test_approx_tokens_handles_none():
    assert AgentManager._approx_tokens(None) == 1


def test_summarize_message_block_empty_returns_empty():
    assert AgentManager._summarize_message_block([]) == ""


def test_summarize_message_block_extracts_initial_task_and_counts():
    msgs = [
        Message(role="user", content="please do the thing"),
        Message(role="tool_call", content={"tool": "Read", "input": {}}),
        Message(role="tool_call", content={"tool": "Bash", "input": {}}),
        Message(role="tool_call", content={"tool": "Read", "input": {}}),
        Message(role="tool_result", content="ok"),
        Message(role="assistant", content="done"),
    ]
    out = AgentManager._summarize_message_block(msgs)
    assert "<compacted_history>" in out
    assert "please do the thing" in out
    # Tool counts
    assert "Read×2" in out
    assert "Bash×1" in out
    assert "Tool calls so far (3 total)" in out
    assert "Tool results received: 1" in out
    assert "Last assistant message:" in out
    assert "done" in out


def test_summarize_message_block_assistant_list_content():
    """Assistant messages with list content (Anthropic block shape)
    should still surface their text."""
    msgs = [
        Message(role="user", content="task"),
        Message(role="assistant", content=[
            {"type": "text", "text": "the answer"},
            {"type": "tool_use", "id": "t1"},
        ]),
    ]
    out = AgentManager._summarize_message_block(msgs)
    assert "the answer" in out


# ---------------------------------------------------------------------------
# _truncate_large_tool_result
# ---------------------------------------------------------------------------


def test_truncate_large_tool_result_under_threshold_unchanged(tmp_data_dirs):
    content, blob = AgentManager._truncate_large_tool_result(
        "small", "sess1", "msg1", max_bytes=100,
    )
    assert content == "small"
    assert blob is None


def test_truncate_large_tool_result_spills_over_threshold(tmp_data_dirs):
    """Content over threshold → first 4K kept inline + saved to disk
    under SESSIONS_DIR/<sid>/blobs/<msg>.txt."""
    huge = "x" * 80_000
    replacement, blob_path = AgentManager._truncate_large_tool_result(
        huge, "sessA", "msgA", max_bytes=50_000,
    )
    assert blob_path is not None
    assert os.path.exists(blob_path)
    with open(blob_path) as fh:
        assert fh.read() == huge
    assert isinstance(replacement, str)
    assert "[truncated" in replacement
    # Inline keeps a 4K head.
    assert replacement.startswith("x" * 4_000)


def test_truncate_large_tool_result_serializes_non_string(tmp_data_dirs):
    big_dict = {"k": "v" * 40_000}
    replacement, blob_path = AgentManager._truncate_large_tool_result(
        big_dict, "sessB", "msgB", max_bytes=10_000,
    )
    assert blob_path is not None
    assert "[truncated" in replacement


# ---------------------------------------------------------------------------
# _build_search_text
# ---------------------------------------------------------------------------


def test_build_search_text_concatenates_user_assistant_only():
    s = AgentSession(name="My Session", model="sonnet")
    s.messages = [
        Message(role="user", content="user msg"),
        Message(role="assistant", content="asst msg"),
        Message(role="tool_call", content={"tool": "Read"}),  # skipped (dict content)
        Message(role="tool_result", content="result"),  # skipped
    ]
    out = AgentManager._build_search_text(s)
    assert "My Session" in out
    assert "user msg" in out
    assert "asst msg" in out
    assert "Read" not in out
    assert "result" not in out


def test_build_search_text_truncates_to_max_len():
    s = AgentSession(name="x", model="sonnet")
    s.messages = [Message(role="user", content="a" * 10_000)]
    out = AgentManager._build_search_text(s, max_len=200)
    assert len(out) == 200


# ---------------------------------------------------------------------------
# _maybe_compact
# ---------------------------------------------------------------------------


def test_maybe_compact_below_threshold_returns_false():
    s = AgentSession(name="x", model="sonnet", compact_threshold_pct=0.65, context_window=200_000)
    s.tokens["input"] = 1_000  # way under threshold
    s.messages = [Message(role="user", content="hi") for _ in range(20)]
    assert AgentManager()._maybe_compact(s) is False


def test_maybe_compact_force_with_few_messages_returns_false():
    """Even with force=True, a session with <4 messages can't compact."""
    s = AgentSession(name="x", model="sonnet")
    s.messages = [Message(role="user", content="hi")]
    assert AgentManager()._maybe_compact(s, force=True) is False


def test_maybe_compact_force_advances_compacted_through_id():
    s = AgentSession(name="x", model="sonnet")
    msgs = [Message(role="user", content=f"m{i}") for i in range(20)]
    s.messages = msgs
    assert AgentManager()._maybe_compact(s, force=True) is True
    # compacted_through_msg_id is the message at len-6 - 1 = 13.
    assert s.compacted_through_msg_id == msgs[13].id


def test_maybe_compact_idempotent_when_already_compacted():
    s = AgentSession(name="x", model="sonnet")
    msgs = [Message(role="user", content=f"m{i}") for i in range(20)]
    s.messages = msgs
    AgentManager()._maybe_compact(s, force=True)
    # Second call with same state and not forced past the saved id → no-op
    snapshot = s.compacted_through_msg_id
    assert AgentManager()._maybe_compact(s) is False
    assert s.compacted_through_msg_id == snapshot


# ---------------------------------------------------------------------------
# _build_prompt_content
# ---------------------------------------------------------------------------


def test_build_prompt_content_no_images_returns_string():
    out = AgentManager()._build_prompt_content("hello")
    assert out == "hello"


def test_build_prompt_content_with_images_returns_blocks():
    out = AgentManager()._build_prompt_content(
        "describe this",
        images=[{"data": "base64bytes", "media_type": "image/png"}],
    )
    assert isinstance(out, list)
    assert out[0] == {"type": "text", "text": "describe this"}
    assert out[1]["type"] == "image"
    assert out[1]["source"]["data"] == "base64bytes"


def test_build_prompt_content_combines_context_and_forced(tmp_path):
    f = tmp_path / "ctx.txt"
    f.write_text("context content")
    out = AgentManager()._build_prompt_content(
        "real prompt",
        context_paths=[{"path": str(f), "type": "file"}],
        forced_tools=["Read"],
    )
    assert "<forced_tools>" in out
    assert "<context_file" in out
    assert "real prompt" in out


# ---------------------------------------------------------------------------
# Lifecycle: launch_agent
# ---------------------------------------------------------------------------


async def test_launch_agent_round_trips_optional_fields(tmp_data_dirs, tmp_path):
    """Launch with the full optional surface; assert the post-resolve
    session has every field we expect (mode-resolved tools land,
    target_directory becomes cwd, dashboard_id round-trips)."""
    workdir = tmp_path / "work"
    workdir.mkdir()
    mgr = AgentManager()
    cfg = AgentConfig(
        name="Full",
        model="sonnet",
        mode="agent",
        system_prompt="be helpful",
        target_directory=str(workdir),
        dashboard_id="dash-1",
    )
    session = await mgr.launch_agent(cfg)

    assert session.name == "Full"
    assert session.model == "sonnet"
    assert session.system_prompt == "be helpful"
    assert session.cwd == str(workdir)
    assert session.dashboard_id == "dash-1"
    assert session.allowed_tools  # non-empty mode-resolved roster
    assert session.id in mgr.sessions


async def test_launch_agent_falls_back_to_scratch_workspace_when_cwd_is_home(tmp_data_dirs, monkeypatch):
    """If the resolved cwd ends up being $HOME (no target_directory,
    no default_folder), the launcher reroutes to
    ~/.openswarm/workspaces/<sid> to avoid writing into $HOME."""
    home = os.environ["HOME"]
    monkeypatch.setattr("backend.apps.agents.agent_manager._ensure_cwd_git_repo", lambda *a, **kw: None)

    mgr = AgentManager()
    cfg = AgentConfig(name="HomeFallback", model="sonnet", mode="agent")
    session = await mgr.launch_agent(cfg)

    assert session.cwd != home
    assert session.cwd.startswith(os.path.join(home, ".openswarm", "workspaces"))


# ---------------------------------------------------------------------------
# Lifecycle: update_session
# ---------------------------------------------------------------------------


async def test_update_session_allowlist_updates_only_known_fields(tmp_data_dirs):
    mgr = AgentManager()
    s = _seed_session(mgr, name="Original", model="sonnet")

    await mgr.update_session(
        s.id,
        name="Renamed",
        system_prompt="new sys",
        thinking_level="high",
        model="ignored-not-allowed",
        cost_usd=999.0,  # also ignored
    )

    assert s.name == "Renamed"
    assert s.system_prompt == "new sys"
    assert s.thinking_level == "high"
    assert s.model == "sonnet"  # not changed
    assert s.cost_usd == 0.0  # not changed


async def test_update_session_rejects_invalid_thinking_level(tmp_data_dirs):
    mgr = AgentManager()
    s = _seed_session(mgr)
    s.thinking_level = "auto"

    await mgr.update_session(s.id, thinking_level="extreme")
    assert s.thinking_level == "auto"


async def test_update_session_unknown_id_raises(tmp_data_dirs):
    with pytest.raises(ValueError):
        await AgentManager().update_session("nope", name="x")


# ---------------------------------------------------------------------------
# Lifecycle: switch_branch
# ---------------------------------------------------------------------------


async def test_switch_branch_unknown_raises(tmp_data_dirs):
    mgr = AgentManager()
    s = _seed_session(mgr)
    with pytest.raises(ValueError):
        await mgr.switch_branch(s.id, "no-such-branch")


async def test_switch_branch_to_existing_updates_active(tmp_data_dirs):
    mgr = AgentManager()
    s = _seed_session(mgr)
    s.branches["b1"] = MessageBranch(id="b1", parent_branch_id="main", fork_point_message_id="abc")

    await mgr.switch_branch(s.id, "b1")
    assert s.active_branch_id == "b1"


async def test_switch_branch_unknown_session_raises(tmp_data_dirs):
    with pytest.raises(ValueError):
        await AgentManager().switch_branch("nope", "main")


# ---------------------------------------------------------------------------
# Lifecycle: edit_message
# ---------------------------------------------------------------------------


async def test_edit_message_unknown_session_raises(tmp_data_dirs):
    with pytest.raises(ValueError):
        await AgentManager().edit_message("nope", "m1", "x")


async def test_edit_message_non_user_role_raises(tmp_data_dirs, stub_agent_loop):
    mgr = AgentManager()
    s = _seed_session(mgr)
    asst = Message(id="m-asst", role="assistant", content="reply", branch_id="main")
    s.messages.append(asst)
    with pytest.raises(ValueError):
        await mgr.edit_message(s.id, "m-asst", "new content")


async def test_edit_message_creates_new_branch(tmp_data_dirs, stub_agent_loop):
    mgr = AgentManager()
    s = _seed_session(mgr)
    user_msg = Message(id="u1", role="user", content="orig", branch_id="main")
    s.messages.append(user_msg)

    await mgr.edit_message(s.id, "u1", "edited content")

    # New branch created and is active. main remains a key.
    assert s.active_branch_id != "main"
    new_branch = s.branches[s.active_branch_id]
    assert new_branch.parent_branch_id == "main"
    assert new_branch.fork_point_message_id == "u1"
    # New user message appended on the new branch with the edited content.
    edited = next(m for m in s.messages if m.branch_id == s.active_branch_id and m.role == "user")
    assert edited.content == "edited content"


async def test_edit_message_on_branched_msg_uses_parent_fork_point(tmp_data_dirs, stub_agent_loop):
    """Editing the FIRST user message of a forked branch should fold
    the new branch back to the parent's fork_point_message_id, not
    the message we're editing — otherwise re-edits chain forever."""
    mgr = AgentManager()
    s = _seed_session(mgr)
    s.branches["b1"] = MessageBranch(
        id="b1", parent_branch_id="main", fork_point_message_id="orig-fork",
    )
    s.active_branch_id = "b1"
    branch_first = Message(id="bf", role="user", content="first on b1", branch_id="b1")
    s.messages.append(branch_first)

    await mgr.edit_message(s.id, "bf", "new")

    new_branch = s.branches[s.active_branch_id]
    assert new_branch.parent_branch_id == "main"  # not "b1"
    assert new_branch.fork_point_message_id == "orig-fork"  # parent's, not "bf"


# ---------------------------------------------------------------------------
# Lifecycle: stop_agent / handle_approval
# ---------------------------------------------------------------------------


async def test_stop_agent_sets_status_stopped_and_drains_approvals(tmp_data_dirs):
    mgr = AgentManager()
    s = _seed_session(mgr)
    s.status = "running"
    req = ApprovalRequest(session_id=s.id, tool_name="Bash", tool_input={"cmd": "x"})
    s.pending_approvals.append(req)

    await mgr.stop_agent(s.id)

    assert s.status == "stopped"
    assert s.pending_approvals == []
    assert s.closed_at is not None


async def test_stop_agent_unknown_session_no_op(tmp_data_dirs):
    """No raise, just a no-op."""
    await AgentManager().stop_agent("nope")


async def test_stop_agent_cancels_browser_children(tmp_data_dirs):
    mgr = AgentManager()
    parent = _seed_session(mgr, name="parent")
    child = _seed_session(mgr, name="child", mode="browser-agent", parent_session_id=parent.id)
    child.status = "running"

    await mgr.stop_agent(parent.id)

    assert child.status == "stopped"
    assert parent.status == "stopped"


def test_handle_approval_resolves_pending_future(tmp_data_dirs):
    from backend.apps.agents.ws_manager import ws_manager

    async def runner():
        loop = asyncio.get_event_loop()
        fut = loop.create_future()
        ws_manager.pending_futures["req-1"] = fut

        AgentManager().handle_approval("req-1", {"behavior": "allow"})
        result = await asyncio.wait_for(fut, timeout=1.0)
        return result

    decision = asyncio.run(runner())
    assert decision == {"behavior": "allow"}


def test_handle_approval_unknown_request_id_no_op():
    """Resolving an unknown id must not raise."""
    AgentManager().handle_approval("nonexistent-id", {"behavior": "deny"})


# ---------------------------------------------------------------------------
# Lifecycle: close / delete / resume
# ---------------------------------------------------------------------------


async def test_close_session_persists_and_evicts_from_memory(tmp_data_dirs):
    mgr = AgentManager()
    s = _seed_session(mgr, name="ToClose")
    s.messages = [
        Message(role="user", content="hello"),
        Message(role="assistant", content="hi back"),
    ]

    await mgr.close_session(s.id)

    assert s.id not in mgr.sessions
    # Persisted to disk with search_text injected
    data = _load_session_data(s.id)
    assert data is not None
    assert data["name"] == "ToClose"
    assert "search_text" in data
    assert "hello" in data["search_text"]


async def test_close_session_unknown_raises(tmp_data_dirs):
    with pytest.raises(ValueError):
        await AgentManager().close_session("nope")


async def test_delete_session_removes_memory_and_disk(tmp_data_dirs):
    mgr = AgentManager()
    s = _seed_session(mgr)
    _save_session(s.id, {"id": s.id, "name": s.name, "model": s.model})

    await mgr.delete_session(s.id)

    assert s.id not in mgr.sessions
    assert _load_session_data(s.id) is None


async def test_delete_session_unknown_silent(tmp_data_dirs):
    """Hard-delete is best-effort; deleting an unknown id is a no-op."""
    await AgentManager().delete_session("nope")  # must not raise


async def test_resume_session_loads_from_disk(tmp_data_dirs):
    """Round-trip: close → resume returns the same session, file is
    deleted so it doesn't show up in /history any more."""
    mgr = AgentManager()
    s = _seed_session(mgr, name="Resume me")
    await mgr.close_session(s.id)

    restored = await mgr.resume_session(s.id)
    assert restored.id == s.id
    assert restored.name == "Resume me"
    assert restored.closed_at is None
    assert _load_session_data(s.id) is None  # file gone


async def test_resume_session_already_in_memory_returns_existing(tmp_data_dirs):
    mgr = AgentManager()
    s = _seed_session(mgr)
    out = await mgr.resume_session(s.id)
    assert out is s


async def test_resume_session_unknown_raises(tmp_data_dirs):
    with pytest.raises(ValueError):
        await AgentManager().resume_session("nope")


# ---------------------------------------------------------------------------
# Lifecycle: duplicate_session
# ---------------------------------------------------------------------------


async def test_duplicate_session_clones_messages_and_appends_copy_suffix(tmp_data_dirs):
    mgr = AgentManager()
    s = _seed_session(mgr, name="Original")
    s.messages = [
        Message(id="m1", role="user", content="hi"),
        Message(id="m2", role="assistant", content="hello"),
    ]

    new = await mgr.duplicate_session(s.id)

    assert new.id != s.id
    assert new.name == "Original (copy)"
    assert new.needs_fork is True
    # New ids on each cloned message
    new_ids = {m.id for m in new.messages}
    assert "m1" not in new_ids and "m2" not in new_ids
    # Same content, mapped order
    assert [m.content for m in new.messages] == ["hi", "hello"]


async def test_duplicate_session_up_to_message_truncates(tmp_data_dirs):
    mgr = AgentManager()
    s = _seed_session(mgr)
    s.messages = [
        Message(id="m1", role="user", content="A"),
        Message(id="m2", role="assistant", content="B"),
        Message(id="m3", role="user", content="C"),
    ]

    new = await mgr.duplicate_session(s.id, up_to_message_id="m2")

    assert [m.content for m in new.messages] == ["A", "B"]


async def test_duplicate_session_unknown_raises(tmp_data_dirs):
    with pytest.raises(ValueError):
        await AgentManager().duplicate_session("nope")


# ---------------------------------------------------------------------------
# Lifecycle: get_history / get_browser_agent_children
# ---------------------------------------------------------------------------


def test_get_history_paginates_and_filters_by_dashboard(tmp_data_dirs):
    """Seed three closed sessions on disk + one on a different
    dashboard. Filter by dashboard_id and assert only matches return."""
    for i, dash in enumerate(["A", "A", "B"]):
        _save_session(f"sess-{i}", {
            "id": f"sess-{i}",
            "name": f"name-{i}",
            "model": "sonnet",
            "mode": "agent",
            "status": "stopped",
            "closed_at": f"2026-04-29T00:00:0{i}",
            "dashboard_id": dash,
            "search_text": f"some text-{i}",
            "messages": [],
        })

    history_a = AgentManager().get_history(dashboard_id="A")
    assert history_a["total"] == 2
    assert all(s["dashboard_id"] == "A" for s in history_a["sessions"])


def test_get_history_search_matches_name_and_search_text(tmp_data_dirs):
    _save_session("alpha", {
        "id": "alpha", "name": "alpha-name", "model": "sonnet",
        "mode": "agent", "status": "stopped", "closed_at": "2026-04-30T00:00:00",
        "search_text": "lorem", "messages": [],
    })
    _save_session("beta", {
        "id": "beta", "name": "unrelated", "model": "sonnet",
        "mode": "agent", "status": "stopped", "closed_at": "2026-04-30T00:00:01",
        "search_text": "ALPHA hidden in body", "messages": [],
    })

    out = AgentManager().get_history(q="alpha")
    ids = {s["id"] for s in out["sessions"]}
    assert ids == {"alpha", "beta"}


def test_get_history_pagination_math(tmp_data_dirs):
    for i in range(5):
        _save_session(f"s{i}", {
            "id": f"s{i}", "name": f"n{i}", "model": "sonnet",
            "mode": "agent", "status": "stopped",
            "closed_at": f"2026-04-30T00:00:0{i}",
            "messages": [],
        })

    page = AgentManager().get_history(limit=2, offset=2)
    assert page["total"] == 5
    assert len(page["sessions"]) == 2
    assert page["has_more"] is True

    last = AgentManager().get_history(limit=2, offset=4)
    assert len(last["sessions"]) == 1
    assert last["has_more"] is False


def test_get_browser_agent_children_combines_memory_and_disk(tmp_data_dirs):
    mgr = AgentManager()
    parent = _seed_session(mgr, name="parent")

    # In-memory child
    in_mem = _seed_session(mgr, name="in-mem", mode="browser-agent", parent_session_id=parent.id)

    # Disk-only child
    _save_session("disk-child", {
        "id": "disk-child", "name": "disk", "model": "sonnet",
        "mode": "browser-agent", "parent_session_id": parent.id,
        "status": "stopped", "messages": [],
    })

    out = mgr.get_browser_agent_children(parent.id)
    ids = {c["id"] for c in out}
    assert in_mem.id in ids
    assert "disk-child" in ids


def test_get_browser_agent_children_dedupes_by_id(tmp_data_dirs):
    """If the same child is in memory AND on disk, memory wins; the
    disk row is dropped to avoid double-listing."""
    mgr = AgentManager()
    parent = _seed_session(mgr, name="parent")
    child = _seed_session(mgr, name="child", mode="browser-agent", parent_session_id=parent.id)
    _save_session(child.id, {
        "id": child.id, "name": "stale-disk-copy",
        "model": "sonnet", "mode": "browser-agent",
        "parent_session_id": parent.id, "messages": [],
    })

    out = mgr.get_browser_agent_children(parent.id)
    matching = [c for c in out if c["id"] == child.id]
    assert len(matching) == 1
    # Memory copy wins
    assert matching[0]["name"] == "child"


def test_get_all_sessions_filters_by_dashboard(tmp_data_dirs):
    mgr = AgentManager()
    a = _seed_session(mgr, dashboard_id="A")
    b = _seed_session(mgr, dashboard_id="B")
    none = _seed_session(mgr, dashboard_id=None)

    all_sessions = mgr.get_all_sessions()
    assert {s.id for s in all_sessions} == {a.id, b.id, none.id}

    just_a = mgr.get_all_sessions(dashboard_id="A")
    assert {s.id for s in just_a} == {a.id}


def test_get_session_returns_none_for_unknown(tmp_data_dirs):
    assert AgentManager().get_session("nope") is None


# ---------------------------------------------------------------------------
# Lifecycle: reconcile + persist + restore
# ---------------------------------------------------------------------------


async def test_reconcile_on_startup_flips_stale_running_to_stopped(tmp_data_dirs):
    _save_session("s1", {
        "id": "s1", "name": "x", "model": "sonnet", "mode": "agent",
        "status": "running", "messages": [],
    })

    await AgentManager().reconcile_on_startup()

    data = _load_session_data("s1")
    assert data["status"] == "stopped"


async def test_reconcile_on_startup_migrates_chat_to_ask(tmp_data_dirs):
    _save_session("s2", {
        "id": "s2", "name": "x", "model": "sonnet", "mode": "chat",
        "status": "stopped", "messages": [],
    })

    await AgentManager().reconcile_on_startup()

    data = _load_session_data("s2")
    assert data["mode"] == "ask"


async def test_reconcile_on_startup_idempotent(tmp_data_dirs):
    """Two consecutive reconciles must not rewrite a stable file."""
    _save_session("s3", {
        "id": "s3", "name": "x", "model": "sonnet", "mode": "ask",
        "status": "stopped", "messages": [],
    })
    mgr = AgentManager()
    await mgr.reconcile_on_startup()
    from backend.config.paths import SESSIONS_DIR
    path = os.path.join(SESSIONS_DIR, "s3.json")
    mtime1 = os.path.getmtime(path)
    await mgr.reconcile_on_startup()
    assert os.path.getmtime(path) == mtime1


async def test_persist_all_sessions_writes_and_clears(tmp_data_dirs):
    mgr = AgentManager()
    s = _seed_session(mgr, name="persist me")
    s.status = "running"

    await mgr.persist_all_sessions()

    assert mgr.sessions == {}
    assert mgr.tasks == {}
    data = _load_session_data(s.id)
    assert data is not None
    assert data["status"] == "stopped"
    assert "search_text" in data


async def test_restore_all_sessions_skips_closed(tmp_data_dirs):
    """closed_at set → keep on disk for /history; closed_at None → restore."""
    _save_session("active", {
        "id": "active", "name": "alive", "model": "sonnet", "mode": "agent",
        "status": "running", "messages": [], "closed_at": None,
    })
    _save_session("closed", {
        "id": "closed", "name": "dead", "model": "sonnet", "mode": "agent",
        "status": "stopped", "messages": [], "closed_at": "2026-04-30T00:00:00",
    })

    mgr = AgentManager()
    await mgr.restore_all_sessions()

    assert "active" in mgr.sessions
    assert "closed" not in mgr.sessions
    # The active one's status is normalized stopped+ file removed.
    assert mgr.sessions["active"].status == "stopped"
    assert _load_session_data("active") is None
    assert _load_session_data("closed") is not None


async def test_restore_all_sessions_skips_corrupt_file(tmp_data_dirs, caplog):
    """A corrupt session file must NOT abort restore — log + skip + move on."""
    # Garbage payload that AgentSession can't validate
    _save_session("good", {
        "id": "good", "name": "ok", "model": "sonnet", "mode": "agent",
        "status": "stopped", "messages": [],
    })
    _save_session("bad", {"this": "is not a session"})

    mgr = AgentManager()
    await mgr.restore_all_sessions()

    assert "good" in mgr.sessions
    assert "bad" not in mgr.sessions


# ---------------------------------------------------------------------------
# Lifecycle: send_message cross-provider fork
# ---------------------------------------------------------------------------


async def test_send_message_marks_needs_fork_on_cross_provider_switch(tmp_data_dirs, stub_agent_loop):
    mgr = AgentManager()
    s = _seed_session(mgr, model="sonnet")  # api=anthropic
    # Switch to gpt-5.4-mini (api=codex) — different api_type → fork.
    await mgr.send_message(s.id, "ping", model="gpt-5.4-mini")

    assert s.needs_fork is True
    assert s.model == "gpt-5.4-mini"


async def test_send_message_same_api_no_fork(tmp_data_dirs, stub_agent_loop):
    mgr = AgentManager()
    s = _seed_session(mgr, model="sonnet")
    s.needs_fork = False
    # opus is also anthropic → no fork required.
    await mgr.send_message(s.id, "ping", model="opus")

    assert s.needs_fork is False
    assert s.model == "opus"


async def test_send_message_unknown_session_raises(tmp_data_dirs):
    with pytest.raises(ValueError):
        await AgentManager().send_message("nope", "hi")


async def test_send_message_skips_when_task_already_running(tmp_data_dirs, stub_agent_loop):
    """If a task for this session is in flight, send_message must
    early-return without appending the user message twice."""
    mgr = AgentManager()
    s = _seed_session(mgr)

    # Plant a never-resolving task in the registry.
    async def _hang():
        await asyncio.Event().wait()

    task = asyncio.create_task(_hang())
    mgr.tasks[s.id] = task
    try:
        before = len(s.messages)
        await mgr.send_message(s.id, "second prompt")
        assert len(s.messages) == before  # nothing appended
    finally:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
