"""OSW_TOOL_MANIFEST gate: default ships the full claude_code preset; flag-on ships an explicit
FULL_TOOLS list that prunes dead preset built-ins WITHOUT dropping anything OpenSwarm uses. The
manifest MUST keep every built-in in effective_allowed's source set + ToolSearch (so deferred MCP
loading survives); MCP tools ride mcp_servers, not this list."""

import os

from backend.apps.agents.manager.prompt.tool_catalog import (
    FULL_TOOLS,
    resolve_builtin_tools_option,
)


def test_default_is_the_full_preset(monkeypatch):
    monkeypatch.delenv("OSW_TOOL_MANIFEST", raising=False)
    assert resolve_builtin_tools_option() == {"type": "preset", "preset": "claude_code"}


def test_flag_on_is_the_explicit_full_tools_manifest(monkeypatch):
    monkeypatch.setenv("OSW_TOOL_MANIFEST", "1")
    out = resolve_builtin_tools_option()
    assert isinstance(out, list)
    assert out == list(FULL_TOOLS)
    # A fresh copy, never the module list itself (a caller mutation must not poison FULL_TOOLS).
    assert out is not FULL_TOOLS


def test_manifest_keeps_toolsearch_so_deferred_mcp_loading_survives(monkeypatch):
    monkeypatch.setenv("OSW_TOOL_MANIFEST", "1")
    out = resolve_builtin_tools_option()
    assert "ToolSearch" in out


def test_manifest_keeps_every_core_builtin_openswarm_exposes(monkeypatch):
    # These are the built-ins the agent actually uses; none may vanish from the manifest.
    monkeypatch.setenv("OSW_TOOL_MANIFEST", "1")
    out = resolve_builtin_tools_option()
    for core in ("Read", "Edit", "Write", "Bash", "Glob", "Grep", "AskUserQuestion"):
        assert core in out


def test_only_the_exact_flag_value_flips_it(monkeypatch):
    monkeypatch.setenv("OSW_TOOL_MANIFEST", "true")  # not "1"
    assert resolve_builtin_tools_option() == {"type": "preset", "preset": "claude_code"}
    monkeypatch.setenv("OSW_TOOL_MANIFEST", "0")
    assert resolve_builtin_tools_option() == {"type": "preset", "preset": "claude_code"}
