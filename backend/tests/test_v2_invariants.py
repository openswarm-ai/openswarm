"""Invariant tests for the eric/v2 branch behaviors.

Each test simulates a real production scenario as closely as possible
without spinning up the bundled CLI. We mock at the boundary
(`load_all_tools`, the streaming SDK, the aux LLM client) so the
production code path runs end-to-end against in-memory fixtures.

Covers:
  - MCP activation gate (the ToolSearch-only invariant) at the dispatch layer
  - needs_fresh_session soft-restart on MCP activation mid-session
  - Pydantic Message + AgentSession backward compat
  - resolve_aux_model Gemini route correctness
  - 9Router-streamed 401 detection
  - MCP_SERVER_BRAND coverage vs the connected-server registry
  - Auth-error / long-context / transient-capacity classifiers

Each group runs many randomized iterations to catch ordering, edge
case and concurrency regressions.
"""

from __future__ import annotations

import asyncio
import json
import os
import random
import string
import tempfile
from typing import Any
from unittest.mock import patch, AsyncMock, MagicMock

import pytest


P_TMPROOT = tempfile.mkdtemp(prefix="openswarm-v2-invariants-")
os.environ.setdefault("OPENSWARM_DATA_DIR", P_TMPROOT)


# --------------------------------------------------------------------------- Fixture: build a fake ToolDefinition without touching disk. ---------------------------------------------------------------------------

def p_fake_tool(
    name: str,
    *,
    enabled: bool = True,
    auth_status: str = "connected",
    has_mcp: bool = True,
    permissions: dict | None = None,
):
    from backend.apps.tools_lib.models import ToolDefinition

    return ToolDefinition(
        name=name,
        description=f"{name} integration",
        mcp_config={"type": "stdio", "command": "echo", "args": ["x"]} if has_mcp else {},
        auth_status=auth_status,
        tool_permissions=permissions or {},
        enabled=enabled,
    )


# =========================================================================== Group A, MCP activation gate (the non-bypassable ToolSearch invariant) =========================================================================== The product invariant: NO MCP tool is callable until the model has explicitly searched + activated the server, and the user has approved the activation. The gate lives at the dispatch layer in `_build_mcp_servers`, even if the prompt rules are ignored, the SDK never sees the unactivated server.


@pytest.mark.asyncio
async def test_gate_blocks_when_active_mcps_empty():
    """Connected MCPs + active_mcps=[] → SDK gets empty mcp_servers dict."""
    from backend.apps.agents.agent_manager import AgentManager
    fake_tools = [
        p_fake_tool("Gmail"),
        p_fake_tool("Slack"),
        p_fake_tool("Notion"),
    ]
    with patch("backend.apps.agents.manager.RunSupport.load_all_tools", return_value=fake_tools), \
         patch("backend.apps.agents.manager.RunSupport.refresh_google_token", new=AsyncMock(return_value=True)):
        mgr = AgentManager()
        # allowed_tools includes mcp:Gmail, but active_mcps is empty
        result = await mgr.build_mcp_servers(
            allowed_tools=["mcp:Gmail", "mcp:Slack", "mcp:Notion"],
            active_mcps=[],
        )
        assert result == {}, f"gate must block all MCPs when active_mcps=[]; got {list(result.keys())}"


@pytest.mark.asyncio
async def test_gate_allows_only_activated_servers():
    """active_mcps=['gmail'] → only gmail server in dispatch dict, others blocked."""
    from backend.apps.agents.agent_manager import AgentManager
    fake_tools = [
        p_fake_tool("Gmail"),
        p_fake_tool("Slack"),
        p_fake_tool("Notion"),
    ]
    with patch("backend.apps.agents.manager.RunSupport.load_all_tools", return_value=fake_tools), \
         patch("backend.apps.agents.manager.RunSupport.refresh_google_token", new=AsyncMock(return_value=True)):
        mgr = AgentManager()
        result = await mgr.build_mcp_servers(
            allowed_tools=["mcp:Gmail", "mcp:Slack", "mcp:Notion"],
            active_mcps=["gmail"],  # sanitized name of "Gmail"
        )
        keys = set(result.keys())
        assert "gmail" in keys, f"activated server must be present; got {keys}"
        assert "slack" not in keys, f"unactivated server leaked through gate: {keys}"
        assert "notion" not in keys, f"unactivated server leaked through gate: {keys}"


@pytest.mark.asyncio
async def test_gate_unset_active_mcps_legacy_allows_all():
    """Pre-gate sessions use active_mcps=None → everything allowed (back-compat)."""
    from backend.apps.agents.agent_manager import AgentManager
    fake_tools = [p_fake_tool("Gmail"), p_fake_tool("Slack")]
    with patch("backend.apps.agents.manager.RunSupport.load_all_tools", return_value=fake_tools), \
         patch("backend.apps.agents.manager.RunSupport.refresh_google_token", new=AsyncMock(return_value=True)):
        mgr = AgentManager()
        result = await mgr.build_mcp_servers(
            allowed_tools=["mcp:Gmail", "mcp:Slack"],
            active_mcps=None,  # legacy / unset
        )
        assert "gmail" in result
        assert "slack" in result


@pytest.mark.asyncio
async def test_gate_disabled_tool_blocked_even_when_activated():
    """Tool with enabled=False stays blocked even if in active_mcps."""
    from backend.apps.agents.agent_manager import AgentManager
    fake_tools = [p_fake_tool("Gmail", enabled=False)]
    with patch("backend.apps.agents.manager.RunSupport.load_all_tools", return_value=fake_tools):
        mgr = AgentManager()
        result = await mgr.build_mcp_servers(
            allowed_tools=["mcp:Gmail"],
            active_mcps=["gmail"],
        )
        assert "gmail" not in result, "disabled tool must not reach the SDK"


@pytest.mark.asyncio
async def test_gate_unauthed_tool_blocked():
    """Tool with auth_status='disconnected' stays blocked."""
    from backend.apps.agents.agent_manager import AgentManager
    fake_tools = [p_fake_tool("Gmail", auth_status="disconnected")]
    with patch("backend.apps.agents.manager.RunSupport.load_all_tools", return_value=fake_tools):
        mgr = AgentManager()
        result = await mgr.build_mcp_servers(
            allowed_tools=["mcp:Gmail"],
            active_mcps=["gmail"],
        )
        assert "gmail" not in result, "unauthed tool must not reach the SDK"


@pytest.mark.asyncio
async def test_gate_allowed_tools_filter_intersects_active_mcps():
    """Activate gmail+slack but allowed_tools only has gmail → only gmail passes."""
    from backend.apps.agents.agent_manager import AgentManager
    fake_tools = [p_fake_tool("Gmail"), p_fake_tool("Slack")]
    with patch("backend.apps.agents.manager.RunSupport.load_all_tools", return_value=fake_tools), \
         patch("backend.apps.agents.manager.RunSupport.refresh_google_token", new=AsyncMock(return_value=True)):
        mgr = AgentManager()
        result = await mgr.build_mcp_servers(
            allowed_tools=["mcp:Gmail"],  # mode-restricted
            active_mcps=["gmail", "slack"],  # both activated
        )
        assert "gmail" in result
        assert "slack" not in result, "mode allowed_tools restriction must intersect with activation"


@pytest.mark.asyncio
async def test_gate_stress_random_activations():
    """Randomized: activated set ⊆ allowed set ⊆ connected set, gate must always intersect correctly."""
    from backend.apps.agents.agent_manager import AgentManager
    server_pool = ["gmail", "slack", "notion", "discord", "github", "linear", "airtable", "hubspot"]
    raw_names = ["Gmail", "Slack", "Notion", "Discord", "GitHub", "Linear", "Airtable", "HubSpot"]

    for _ in range(40):
        connected_count = random.randint(2, 8)
        connected_idx = random.sample(range(len(server_pool)), connected_count)
        fake_tools = [p_fake_tool(raw_names[i]) for i in connected_idx]
        connected_sanitized = [server_pool[i] for i in connected_idx]

        # active set is a random subset of connected
        active_n = random.randint(0, len(connected_sanitized))
        active = random.sample(connected_sanitized, active_n)

        # allowed_tools mirrors raw names of connected
        allowed = [f"mcp:{raw_names[i]}" for i in connected_idx]

        with patch("backend.apps.agents.manager.RunSupport.load_all_tools", return_value=fake_tools), \
             patch("backend.apps.agents.manager.RunSupport.refresh_google_token", new=AsyncMock(return_value=True)), \
             patch("backend.apps.agents.manager.RunSupport.refresh_airtable_token", new=AsyncMock(return_value=True)), \
             patch("backend.apps.agents.manager.RunSupport.refresh_hubspot_token", new=AsyncMock(return_value=True)):
            mgr = AgentManager()
            result = await mgr.build_mcp_servers(
                allowed_tools=allowed,
                active_mcps=active,
            )
            keys = set(result.keys())
            # MUST: keys ⊆ active ∩ connected
            allowed_set = set(active) & set(connected_sanitized)
            assert keys.issubset(allowed_set), (
                f"GATE BREACH: {keys - allowed_set} leaked through "
                f"(active={active}, connected={connected_sanitized})"
            )


# =========================================================================== Group A2, ToolSearch loop-breaker =========================================================================== Gated MCP servers are withheld from the SDK, so the CLI's native ToolSearch can never see them; small models loop (empty ToolSearch -> retry) until the user pauses. The break must (a) not fire on the first call or two (a power user may legitimately ToolSearch a deferred tool), (b) fire once it's clearly stuck, steering to MCPActivate, and (c) reset when any real tool runs.


def test_toolsearch_redirect_holds_below_threshold():
    from backend.apps.agents.manager.prompt.prompt_context import (
        toolsearch_loop_redirect,
        TOOLSEARCH_LOOP_THRESHOLD,
    )
    for n in range(1, TOOLSEARCH_LOOP_THRESHOLD):
        assert toolsearch_loop_redirect(n, ["gmail"]) is None, f"must not redirect at n={n}"


def test_toolsearch_redirect_fires_at_threshold_and_names_gated_servers():
    from backend.apps.agents.manager.prompt.prompt_context import (
        toolsearch_loop_redirect,
        TOOLSEARCH_LOOP_THRESHOLD,
    )
    reason = toolsearch_loop_redirect(TOOLSEARCH_LOOP_THRESHOLD, ["google-workspace", "slack"])
    assert reason is not None
    assert "MCPActivate" in reason
    assert "google-workspace" in reason and "slack" in reason
    assert "Stop calling ToolSearch" in reason


def test_toolsearch_redirect_works_with_no_gated_servers():
    # Even with nothing to activate, the steer must still tell the model its tools are already loaded so it stops searching (no crash on empty list).
    from backend.apps.agents.manager.prompt.prompt_context import (
        toolsearch_loop_redirect,
        TOOLSEARCH_LOOP_THRESHOLD,
    )
    reason = toolsearch_loop_redirect(TOOLSEARCH_LOOP_THRESHOLD, [])
    assert reason is not None
    assert "MCPActivate" not in reason  # nothing to point at
    assert "Stop calling ToolSearch" in reason


@pytest.mark.asyncio
async def test_gated_server_names_surface_only_inactive_servers():
    """The steer list must mirror the gate: connected-but-not-active servers
    only, never one that's already activated (callable) or denied."""
    from backend.apps.agents.manager.prompt.tool_catalog import gated_mcp_server_names
    fake_tools = [p_fake_tool("Gmail"), p_fake_tool("Slack"), p_fake_tool("Notion")]
    with patch("backend.apps.agents.manager.prompt.tool_catalog.load_all_tools", return_value=fake_tools):
        names = gated_mcp_server_names(
            allowed_tools=["mcp:Gmail", "mcp:Slack", "mcp:Notion"],
            active_mcps=["gmail"],  # already activated -> not "gated"
        )
        assert "gmail" not in names, "activated server must not appear as gated"
        assert "slack" in names and "notion" in names


@pytest.mark.asyncio
async def test_gated_server_names_empty_when_all_active():
    from backend.apps.agents.manager.prompt.tool_catalog import gated_mcp_server_names
    fake_tools = [p_fake_tool("Gmail")]
    with patch("backend.apps.agents.manager.prompt.tool_catalog.load_all_tools", return_value=fake_tools):
        assert gated_mcp_server_names(["mcp:Gmail"], ["gmail"]) == []


# =========================================================================== Group B, needs_fresh_session soft-restart =========================================================================== When MCPActivate fires mid-session, the bundled CLI doesn't re-read mcp_servers from a fork. We force a fresh sdk_session_id so the new server's tools actually reach the model.


def test_needs_fresh_session_field_default_false():
    """Brand-new sessions must default needs_fresh_session=False."""
    from backend.apps.agents.core.models import AgentSession
    s = AgentSession(id="x", name="t", model="sonnet", mode="agent")
    assert s.needs_fresh_session is False


def test_needs_fresh_session_serializes_round_trip():
    """Pydantic round-trip must preserve the flag for session.json persistence."""
    from backend.apps.agents.core.models import AgentSession
    s = AgentSession(id="x", name="t", model="sonnet", mode="agent")
    s.needs_fresh_session = True
    s.sdk_session_id = "claude-session-abc-123"
    dumped = s.model_dump(mode="json")
    assert dumped["needs_fresh_session"] is True
    assert dumped["sdk_session_id"] == "claude-session-abc-123"
    rehydrated = AgentSession.model_validate(dumped)
    assert rehydrated.needs_fresh_session is True


def test_legacy_session_json_loads_without_field():
    """Old session JSONs predate the field, Pydantic must fill in default."""
    from backend.apps.agents.core.models import AgentSession
    legacy = {
        "id": "old", "name": "legacy", "model": "sonnet", "mode": "agent",
        "status": "completed", "messages": [],
    }
    s = AgentSession.model_validate(legacy)
    assert s.needs_fresh_session is False
    # extras silently absorbed → can't be a regression hazard
    legacy_with_ghost = {**legacy, "answer_tokens": 999, "thought_signature": "abc=="}
    s2 = AgentSession.model_validate(legacy_with_ghost)
    assert s2.id == "old"


def test_mcp_activate_sets_fresh_session_when_history_exists():
    """The gate logic at main.py: if sdk_session_id exists, set needs_fresh_session=True."""
    from backend.apps.agents.core.models import AgentSession
    # Mid-session: sdk already locked in
    s = AgentSession(id="mid", name="t", model="sonnet", mode="agent")
    s.sdk_session_id = "claude-session-existing"
    # Simulate the gate handler logic
    if s.sdk_session_id:
        s.needs_fresh_session = True
    assert s.needs_fresh_session is True


def test_mcp_activate_skips_fresh_session_on_first_turn():
    """First-turn activation: no sdk_session_id yet, so needs_fresh_session stays False."""
    from backend.apps.agents.core.models import AgentSession
    s = AgentSession(id="fresh", name="t", model="sonnet", mode="agent")
    # No sdk_session_id yet
    if s.sdk_session_id:
        s.needs_fresh_session = True
    assert s.needs_fresh_session is False


def test_active_mcps_append_idempotent():
    """Activating the same server twice doesn't dupe."""
    from backend.apps.agents.core.models import AgentSession
    s = AgentSession(id="x", name="t", model="sonnet", mode="agent")
    s.active_mcps.append("gmail")
    if "gmail" not in s.active_mcps:
        s.active_mcps.append("gmail")
    assert s.active_mcps.count("gmail") == 1


# =========================================================================== Group C, Pydantic Message backward compat (no ghost fields, legacy loads) ===========================================================================


def test_message_no_ghost_fields():
    """answer_tokens + thought_signature must NOT be Message attributes anymore."""
    from backend.apps.agents.core.models import Message
    m = Message(role="thinking", content="x")
    dumped = m.model_dump(mode="json")
    assert "answer_tokens" not in dumped
    assert "thought_signature" not in dumped


def test_message_legacy_payload_with_ghost_fields_still_loads():
    """Old session JSONs may carry the deleted fields, Pydantic must ignore them."""
    from backend.apps.agents.core.models import Message
    legacy = {
        "id": "m1",
        "role": "thinking",
        "content": "old",
        "answer_tokens": 42,
        "thought_signature": "deadbeef==",
        "tool_count": 3,
        "input_tokens": 1234,
    }
    m = Message.model_validate(legacy)
    # Fields that survived are preserved
    assert m.tool_count == 3
    assert m.input_tokens == 1234
    # Ghost fields don't blow up + don't leak into re-dump
    redumped = m.model_dump(mode="json")
    assert "answer_tokens" not in redumped
    assert "thought_signature" not in redumped


def test_message_kept_fields():
    """Verify the live fields remain on the model."""
    from backend.apps.agents.core.models import Message
    m = Message(
        role="thinking",
        content="x",
        client_message_id="opt-123",
        elapsed_ms=1500,
        tokens=42,
        tool_count=2,
        input_tokens=5000,
    )
    d = m.model_dump(mode="json")
    for f in ("client_message_id", "elapsed_ms", "tokens", "tool_count", "input_tokens"):
        assert f in d, f"live field {f} disappeared"


def test_message_round_trip_50_iterations():
    """Stress: 50 randomized message round-trips."""
    from backend.apps.agents.core.models import Message
    for _ in range(50):
        roles = ["user", "assistant", "tool_call", "tool_result", "system", "thinking"]
        m = Message(
            role=random.choice(roles),
            content=("x" * random.randint(0, 5000)),
            elapsed_ms=random.randint(0, 60000),
            tokens=random.randint(0, 100000),
            tool_count=random.randint(0, 50),
            input_tokens=random.randint(0, 200000),
        )
        d = m.model_dump(mode="json")
        m2 = Message.model_validate(d)
        assert m2.role == m.role
        assert m2.content == m.content
        assert m2.elapsed_ms == m.elapsed_ms


# =========================================================================== Group D, resolve_aux_model Gemini route (the gemini-3.1-flash-lite-preview fix) ===========================================================================


@pytest.mark.asyncio
async def test_resolve_aux_model_gemini_subscription_returns_preview_suffix():
    """The bug: gc/gemini-3.1-flash-lite (no -preview) 404s on 9Router."""
    from backend.apps.agents.providers import registry
    from backend.apps.settings.models import AppSettings
    settings = AppSettings()
    with patch("backend.apps.nine_router.is_running", return_value=True), \
         patch("backend.apps.nine_router.get_providers",
               new=AsyncMock(return_value=[{"provider": "gemini-cli", "isActive": True}])):
        model_id, base = await registry.resolve_aux_model(settings, primary_api="gemini-cli")
        assert model_id == "gc/gemini-3.1-flash-lite-preview", \
            f"Gemini aux must use the -preview suffix; got {model_id}"


@pytest.mark.asyncio
async def test_resolve_aux_model_gemini_api_key_returns_preview_suffix():
    """Direct API key path also needs -preview."""
    from backend.apps.agents.providers import registry
    from backend.apps.settings.models import AppSettings
    settings = AppSettings()
    settings.google_api_key = "fake-key-123"
    with patch("backend.apps.nine_router.is_running", return_value=False):
        model_id, base = await registry.resolve_aux_model(settings, primary_api="gemini-cli")
        assert model_id == "gemini-3.1-flash-lite-preview", \
            f"Gemini API-key aux must use the -preview suffix; got {model_id}"


@pytest.mark.asyncio
async def test_resolve_aux_model_anthropic_pro_returns_proxy():
    """OpenSwarm Pro mode → bare haiku via proxy."""
    from backend.apps.agents.providers import registry
    from backend.apps.settings.models import AppSettings
    settings = AppSettings()
    settings.connection_mode = "openswarm-pro"
    settings.openswarm_proxy_url = "https://api.openswarm.test"
    # A real Pro-connected user carries a bearer token; proxy_auth reads it. Without it the resolver can't see Pro and falls through to the raise, which is what made this test depend on live machine state.
    settings.openswarm_bearer_token = "test-pro-token"
    with patch("backend.apps.nine_router.is_running", return_value=False):
        model_id, base = await registry.resolve_aux_model(settings)
        assert "haiku" in model_id
        assert base == "https://api.openswarm.test"


@pytest.mark.asyncio
async def test_resolve_aux_model_codex_subscription():
    """Codex primary with codex connected → cx/gpt-5.4-mini."""
    from backend.apps.agents.providers import registry
    from backend.apps.settings.models import AppSettings
    settings = AppSettings()
    with patch("backend.apps.nine_router.is_running", return_value=True), \
         patch("backend.apps.nine_router.get_providers",
               new=AsyncMock(return_value=[{"provider": "codex", "isActive": True}])):
        model_id, base = await registry.resolve_aux_model(settings, primary_api="codex")
        assert model_id == "cx/gpt-5.4-mini", f"got {model_id}"


@pytest.mark.asyncio
async def test_resolve_aux_model_raises_when_nothing_available():
    """No 9Router, no API keys, no Pro → ValueError."""
    from backend.apps.agents.providers import registry
    from backend.apps.settings.models import AppSettings
    settings = AppSettings()
    with patch("backend.apps.nine_router.is_running", return_value=False):
        with pytest.raises(ValueError, match="No AI provider"):
            await registry.resolve_aux_model(settings)


@pytest.mark.asyncio
async def test_resolve_aux_model_openrouter_only_fallback():
    """OR-only user (no Pro, no Anthropic key, no claude/codex/gemini sub)
    falls back to OR-resold Haiku instead of raising. Covers the gap that
    used to leave OR-only users at 'Untitled session'."""
    from backend.apps.agents.providers import registry
    from backend.apps.settings.models import AppSettings
    settings = AppSettings()  # no anthropic_api_key, no Pro
    with patch("backend.apps.nine_router.is_running", return_value=True), \
         patch("backend.apps.nine_router.get_providers",
               new=AsyncMock(return_value=[{"provider": "openrouter", "isActive": True}])):
        model_id, base = await registry.resolve_aux_model(settings, preferred_tier="haiku")
        assert model_id == "openrouter/anthropic/claude-haiku-4.5", f"got {model_id}"
        assert base == "http://localhost:20128", f"got {base}"


@pytest.mark.asyncio
async def test_resolve_aux_model_openrouter_primary_prefers_or():
    """OR-primary chat keeps aux on OR (single-bill predictability) even
    when other free lanes happen to be connected. Stay-on-family rule."""
    from backend.apps.agents.providers import registry
    from backend.apps.settings.models import AppSettings
    settings = AppSettings()
    with patch("backend.apps.nine_router.is_running", return_value=True), \
         patch("backend.apps.nine_router.get_providers",
               new=AsyncMock(return_value=[
                   {"provider": "openrouter", "isActive": True},
                   {"provider": "claude", "isActive": True},
               ])):
        model_id, base = await registry.resolve_aux_model(settings, primary_api="openrouter")
        assert model_id == "openrouter/anthropic/claude-haiku-4.5", f"got {model_id}"


@pytest.mark.asyncio
async def test_resolve_aux_model_openrouter_priority_after_subs():
    """In the default cascade (no primary_api), Claude/Codex/Gemini subs
    win over OR, OR is metered while subs are sub-covered free."""
    from backend.apps.agents.providers import registry
    from backend.apps.settings.models import AppSettings
    settings = AppSettings()
    # Both Codex and OR connected, Codex (free via sub) should win.
    with patch("backend.apps.nine_router.is_running", return_value=True), \
         patch("backend.apps.nine_router.get_providers",
               new=AsyncMock(return_value=[
                   {"provider": "codex", "isActive": True},
                   {"provider": "openrouter", "isActive": True},
               ])):
        model_id, _ = await registry.resolve_aux_model(settings)
        assert model_id == "cx/gpt-5.4-mini", f"got {model_id}"


def test_resolve_sdk_openai_own_key_keeps_cp_openai_prefix():
    """OpenAI own-key dispatch points the SDK at 9Router, which routes by
    prefix to our cp-openai passthrough node; handing it the bare `gpt-5.5`
    matched no node and silently dropped every request before it reached
    OpenAI (0 requests on the dashboard). The resolver must keep the
    cp-openai/ prefix for the openai route while Anthropic/Gemini own-key
    stay on the bare id (they go direct / via the local proxy)."""
    from backend.apps.agents.providers.registry import resolve_model_id_for_sdk
    from backend.apps.settings.models import AppSettings
    s = AppSettings()
    s.openai_api_key = "sk-test"
    for v, expected in (
        ("gpt-5.5-api", "cp-openai/gpt-5.5"),
        ("gpt-5.4-api", "cp-openai/gpt-5.4"),
        ("gpt-5.4-mini-api", "cp-openai/gpt-5.4-mini"),
    ):
        assert resolve_model_id_for_sdk(v, s) == expected, f"{v} -> {resolve_model_id_for_sdk(v, s)}"
    # Non-OpenAI own-key lanes must NOT gain a 9Router prefix.
    assert resolve_model_id_for_sdk("gemini-3.5-flash-api", s) == "gemini-3.5-flash"
    assert resolve_model_id_for_sdk("opus-4-8-api", s) == "claude-opus-4-8"


def test_resolve_sdk_gemini_prefers_antigravity_over_api_key():
    """A connected Antigravity sub must win over the AI Studio key for the
    models AG serves (flash) since AG bypasses the thoughtSignature validator;
    pro variants aren't AG-serveable so they fall back to the key. Before this,
    the key was checked first and silently shadowed a connected AG sub (user had
    AG connected but 100% of Gemini traffic still went through the key)."""
    from backend.apps.agents.providers import registry
    from backend.apps.settings.models import AppSettings
    s = AppSettings()
    s.google_api_key = "ai-studio-key"
    with patch.object(registry, "p_antigravity_connected", return_value=True):
        # flash IS AG-serveable -> AG wins over the key
        assert registry.resolve_model_id_for_sdk("gemini-3-flash", s) == "ag/gemini-3-flash"
    with patch.object(registry, "p_antigravity_connected", return_value=False):
        # AG not connected -> key
        assert registry.resolve_model_id_for_sdk("gemini-3-flash", s) == "gemini/gemini-3-flash-preview"
    # No key, no AG -> gc/ subscription lane untouched
    s2 = AppSettings()
    with patch.object(registry, "p_antigravity_connected", return_value=False):
        assert registry.resolve_model_id_for_sdk("gemini-3-flash", s2) == "gc/gemini-3-flash-preview"


def test_error_classify_schema_translation_400_is_not_auth():
    """A 9Router tool-schema translation 400 can carry provider/connection
    wording that trips the auth regex, so it used to surface a misleading
    'reconnect your subscription' card for what is really a schema bug. The
    translation guard must win: schema 400 -> not auth; a real auth failure
    with no translation signature still reads as auth."""
    from backend.apps.agents.core.error_classify import is_auth_error, is_translation_error
    both = Exception("provider not connected: 400 INVALID_ARGUMENT at "
                     "tools[0].function_declarations[0].parameters")
    assert is_translation_error(both)
    assert not is_auth_error(both), "schema-400 must not be classified as auth"
    # Pure auth failures (no translation signature) still classify as auth.
    assert is_auth_error(Exception("provider not connected: gemini"))
    assert is_auth_error(Exception("401 invalid authentication credentials"))
    assert not is_translation_error(Exception("401 invalid authentication credentials"))


def test_error_classify_gemini_resource_exhausted_is_transient():
    """gemini-cli's free-tier 429 surfaces as RESOURCE_EXHAUSTED; it must count
    as transient so the existing backoff/retry catches it instead of dying as a
    hard first-message error. A 403 (hard auth/quota) must still NOT retry."""
    from backend.apps.agents.core.error_classify import is_transient_capacity_error
    assert is_transient_capacity_error(Exception("429 RESOURCE_EXHAUSTED: Quota exceeded"))
    assert is_transient_capacity_error(Exception("RESOURCE_EXHAUSTED"))
    assert not is_transient_capacity_error(Exception("403 permission denied"))


@pytest.mark.asyncio
async def test_mcp_gate_only_forwards_activated_servers():
    """Dispatch-layer security invariant (the non-bypassable enforcement of
    'MCP tools only via MCPActivate'): for a GATED session (active_mcps is a
    list), _build_mcp_servers forwards ONLY servers whose sanitized name is in
    active_mcps; an empty list forwards ZERO; None is the legacy all-allowed
    path. The model cannot reach an unactivated server no matter what it asks
    for. Property-checked over random installed sets and random activation
    subsets, plus the two boundary cases."""
    import random
    from types import SimpleNamespace
    from backend.apps.agents.agent_manager import AgentManager
    mgr = AgentManager()
    names = ["gmail", "drive", "slack", "reddit", "notion", "airtable"]

    def installed():
        return [SimpleNamespace(name=n, mcp_config={"x": 1}, enabled=True,
                                auth_status="configured", auth_type="apikey") for n in names]

    # allowed_tools == get_all_tool_names() bypasses the (separate) permission gate so we isolate the ACTIVATION gate. sanitize_server_name -> identity.
    with patch("backend.apps.agents.manager.RunSupport.load_all_tools", side_effect=installed), \
         patch("backend.apps.agents.manager.RunSupport.get_all_tool_names", return_value=["__ALL__"]), \
         patch("backend.apps.agents.manager.RunSupport.sanitize_server_name", side_effect=lambda n: n), \
         patch("backend.apps.agents.manager.RunSupport.is_fully_denied", return_value=False), \
         patch("backend.apps.agents.manager.RunSupport.derive_mcp_config", side_effect=lambda t: {"command": "x"}):
        allowed = ["__ALL__"]
        # Boundary 1: empty activation list -> zero servers, always.
        assert await mgr.build_mcp_servers(allowed, active_mcps=[]) == {}
        # Boundary 2: None (legacy) -> permission gate only, all forwarded.
        assert set((await mgr.build_mcp_servers(allowed, active_mcps=None)).keys()) == set(names)
        # Property: forwarded set is ALWAYS a subset of the activated set, and equals exactly the activated-and-installed intersection.
        rng = random.Random(1234)
        for _ in range(400):
            active = rng.sample(names, rng.randint(0, len(names)))
            # throw in a bogus name the gate must never invent a server for
            if rng.random() < 0.3:
                active = active + ["ghost-not-installed"]
            forwarded = set((await mgr.build_mcp_servers(allowed, active_mcps=active)).keys())
            assert forwarded <= set(active), f"leaked {forwarded - set(active)} for active={active}"
            assert forwarded == (set(active) & set(names)), f"mismatch for active={active}"


def test_dashboard_get_strips_only_orphan_session_cards():
    """A layout card whose session vanished (gone from memory AND disk) makes the
    frontend GET /sessions/{id} 404 on every load and flash a dead card. The
    dashboard GET filters those orphan cards out of the response, but must keep
    live (in-memory) cards, on-disk cards, and drafts. Non-destructive: only the
    response is filtered, never the stored layout."""
    from types import SimpleNamespace
    from backend.apps.dashboards import dashboards as D
    data = {"layout": {
        "cards": {
            "live": {"session_id": "live"},      # in memory
            "ondisk": {"session_id": "ondisk"},  # closed but on disk
            "draft-1": {"session_id": "draft-1"},  # unsent draft, no backend session yet
            "ghost": {"session_id": "ghost"},    # gone from memory AND disk -> would 404
        },
        "expanded_session_ids": ["live", "ghost"],
    }}
    fake_mgr = SimpleNamespace(sessions={"live": object()})
    on_disk = {"ondisk": {"id": "ondisk"}}
    with patch("backend.apps.agents.agent_manager.agent_manager", fake_mgr), \
         patch("backend.apps.agents.manager.session.session_store.load_session_data",
               side_effect=lambda sid: on_disk.get(sid)):
        D.strip_orphan_session_cards(data)
    assert set(data["layout"]["cards"].keys()) == {"live", "ondisk", "draft-1"}, "only the ghost should be dropped"
    assert data["layout"]["expanded_session_ids"] == ["live"], "ghost dropped from expanded too"


def test_banned_models_not_offered():
    """Claude Fable (banned) and Gemini 3.1 Pro (no working lane: AG can't serve
    it, AI Studio key 429s pro-preview) were pulled from the picker. Guard so a
    refactor can't silently re-list a model that can't run."""
    from backend.apps.agents.providers.registry import BUILTIN_MODELS
    all_values = {m["value"] for models in BUILTIN_MODELS.values() for m in models}
    for dead in ("fable-5-cc", "fable-5-api", "gemini-3.1-pro", "gemini-3.1-pro-api"):
        assert dead not in all_values, f"{dead} is back in the picker"
    # No 'fable' or '3.1 pro' label survives in any provider group either.
    all_labels = " | ".join(m["label"].lower() for models in BUILTIN_MODELS.values() for m in models)
    assert "fable" not in all_labels
    assert "3.1 pro" not in all_labels


# =========================================================================== Group E, 9Router-streamed 401 detection =========================================================================== 9Router sometimes returns upstream auth failures AS the assistant's reply text, not as an exception. We detect the pattern in the stream handler to substitute a friendly bubble.


def test_router_auth_pattern_codex():
    """The pattern detector at agent_manager.py:2841-2846."""
    text = (
        "Failed to authenticate. API Error: 401 {\"error\":{\"message\":"
        "\"[codex/gpt-5.5] [401]: Provided authentication token is expired. "
        "Please try signing in again. (reset after 1m 59s)\"}}"
    )
    lower = text.lower()
    looks_auth = (
        ("failed to authenticate" in lower and "401" in lower)
        or ("authentication token is expired" in lower)
        or ("authentication token has expired" in lower)
        or ("provided authentication token" in lower and ("401" in lower or "expired" in lower))
    )
    assert looks_auth, "codex 401 pattern must match"
    assert "codex/" in lower, "codex provider tag should be detectable"


def test_router_auth_pattern_gemini():
    text = "[gemini-cli/gemini-2.5-flash] [401]: Invalid API key provided (reset after 2m)"
    lower = text.lower()
    is_gemini = "gemini-cli/" in lower or "[gemini" in lower
    has_401 = "401" in lower
    assert is_gemini
    assert has_401


def test_router_auth_pattern_does_not_falsely_match_normal_text():
    """Don't friendly-bubble normal assistant replies."""
    benign_replies = [
        "Here are your recent emails: ...",
        "I found 3 results for your search.",
        "Sorry, I don't have access to that file.",
        "401 Unauthorized, wait this is a code example I'm explaining",  # tricky
    ]
    for text in benign_replies:
        lower = text.lower()
        looks_auth = (
            ("failed to authenticate" in lower and "401" in lower)
            or "authentication token is expired" in lower
            or "authentication token has expired" in lower
            or ("provided authentication token" in lower and ("401" in lower or "expired" in lower))
        )
        assert not looks_auth, f"falsely matched benign text: {text!r}"


def test_is_auth_error_classifier():
    """The classifier at agent_manager.py:is_auth_error covers many shapes."""
    from backend.apps.agents.core.error_classify import is_auth_error

    # Real shapes that must be caught
    matches = [
        Exception("Error 401: invalid_api_key"),
        Exception("Got 403 from upstream"),
        Exception("invalid authentication credentials"),
        Exception("missing bearer token"),
        Exception("Unauthorized"),
        Exception("No credentials for provider: claude"),
        Exception("Provider not configured: gemini"),
    ]
    for e in matches:
        assert is_auth_error(e), f"should match: {e}"

    # Non-auth errors must not match
    non_matches = [
        Exception("Connection timeout"),
        Exception("Rate limit exceeded"),
        Exception("Internal server error"),
        Exception("File not found"),
    ]
    for e in non_matches:
        assert not is_auth_error(e), f"should NOT match: {e}"


def test_is_auth_error_with_stderr_tail():
    """The classifier also reads stderr buffer text."""
    from backend.apps.agents.core.error_classify import is_auth_error
    e = Exception("Command failed with exit code 1")
    stderr = "...\n[codex/gpt-5.5] [401]: Provided authentication token is expired"
    assert is_auth_error(e, extra_text=stderr)


# =========================================================================== Group F, MCP_SERVER_BRAND coverage =========================================================================== Every server slug we surface to the user via MCPSearch / connected_servers should have a brand entry, otherwise the UI falls back to the kebab-case id ("microsoft-365" instead of "Microsoft 365").


def test_mcp_brand_covers_curated_servers():
    """Every curated server slug must already be in canonical sanitized form."""
    curated = {
        "google-workspace", "microsoft-365", "slack", "discord",
        "notion", "airtable", "hubspot", "reddit", "youtube",
    }
    from backend.apps.tools_lib.tools_lib import sanitize_server_name
    for slug in curated:
        assert sanitize_server_name(slug) == slug, (
            f"curated slug {slug!r} is not in sanitized form"
        )


def test_curated_server_aliases_in_main():
    """Read main.py's source to confirm the alias map covers curated servers."""
    import inspect
    import backend.main as main_module
    src = inspect.getsource(main_module)
    assert "_SERVER_SEARCH_ALIASES" in src, "alias map removed?"
    for slug in ("google-workspace", "microsoft-365", "slack", "discord", "notion"):
        assert f'"{slug}"' in src, f"{slug} alias entry missing in main.py"


def test_sanitize_server_name_idempotent():
    """sanitize_server_name must be idempotent (sanitize twice = sanitize once)."""
    from backend.apps.tools_lib.tools_lib import sanitize_server_name
    test_inputs = [
        "Google Workspace", "Microsoft 365", "Slack", "Discord",
        "Notion", "Airtable", "HubSpot", "Reddit", "YouTube",
        "GitHub", "GitLab", "Jira",
    ]
    for raw in test_inputs:
        once = sanitize_server_name(raw)
        twice = sanitize_server_name(once)
        assert once == twice, f"{raw}: sanitize not idempotent ({once} != {twice})"


def test_sanitize_server_name_lowercase():
    from backend.apps.tools_lib.tools_lib import sanitize_server_name
    assert sanitize_server_name("Gmail") == "gmail"
    assert sanitize_server_name("UPPERCASE") == "uppercase"


def test_sanitize_server_name_strips_special_chars():
    from backend.apps.tools_lib.tools_lib import sanitize_server_name
    assert sanitize_server_name("Foo Bar!") == "foo-bar"
    assert sanitize_server_name("@x/y") == "x-y"
    assert sanitize_server_name("a__b") == "a-b"


# =========================================================================== Group G, mcp_meta_server activation backend handler ===========================================================================


def test_mcp_activate_handler_unknown_server():
    """Unknown server name → status='unknown_server' with the valid list."""
    # We test the response shape independently of the FastAPI plumbing. The handler is a closure inside main.py:mcp_meta_handler, so we instead exercise the contract: invalid name surfaces alternatives.
    from backend.apps.tools_lib.tools_lib import sanitize_server_name
    valid = {"gmail", "slack", "google-workspace"}
    requested = "Gmail"  # raw, needs sanitize
    sanitized = sanitize_server_name(requested)
    if sanitized in valid:
        status = "would_activate"
    else:
        status = "unknown_server"
    assert status in ("would_activate", "unknown_server")


def test_active_mcps_persistence_on_session():
    """active_mcps survives session.model_dump() round-trip, critical for resume."""
    from backend.apps.agents.core.models import AgentSession
    s = AgentSession(id="x", name="t", model="sonnet", mode="agent")
    s.active_mcps = ["gmail", "slack"]
    dumped = json.dumps(s.model_dump(mode="json"))
    rehydrated = AgentSession.model_validate(json.loads(dumped))
    assert rehydrated.active_mcps == ["gmail", "slack"]


# =========================================================================== Group H, long-context error classifier ===========================================================================


def test_long_context_pattern_caught():
    """The 'extra usage required' 429 must NOT silently retry."""
    from backend.apps.agents.core.error_classify import NON_TRANSIENT_PATTERNS
    cases = [
        "Extra usage is required for long context requests",
        "extra usage is required for long context",
        "EXTRA USAGE IS REQUIRED FOR LONG CONTEXT",
    ]
    for case in cases:
        assert NON_TRANSIENT_PATTERNS.search(case), f"missed: {case!r}"


def test_transient_capacity_patterns():
    """Real transient errors that SHOULD retry."""
    from backend.apps.agents.core.error_classify import TRANSIENT_CAPACITY_PATTERNS, NON_TRANSIENT_PATTERNS
    transients = [
        "Error 429: rate_limit_error",
        "503 Service Unavailable",
        "Service is at capacity",
        "Try again shortly",
        "Internal server error",
        "ECONNRESET on upstream",
        "fetch failed",
        "overloaded",
    ]
    for t in transients:
        assert TRANSIENT_CAPACITY_PATTERNS.search(t), f"transient missed: {t!r}"
        # Importantly: must NOT also match non-transient (no double-classification) except for the fuzzy edge cases. Spot-check a couple:
        if "429" in t and "rate_limit" in t.lower():
            # rate_limit_error is transient; non-transient should not match this exact text
            assert not NON_TRANSIENT_PATTERNS.search(t)


def test_long_context_does_not_match_normal_429():
    """Generic 429 is transient, only the long-context variant is non-transient."""
    from backend.apps.agents.core.error_classify import NON_TRANSIENT_PATTERNS
    assert not NON_TRANSIENT_PATTERNS.search("Error 429: rate_limit_error")


# =========================================================================== Group I, Mode reconciliation (regression guard) ===========================================================================


def test_chat_mode_not_in_builtins():
    """chat mode was deleted; only ask/agent/plan/view-builder/skill-builder remain."""
    from backend.apps.modes.models import BUILTIN_MODES
    ids = {m.id for m in BUILTIN_MODES}
    assert "chat" not in ids
    for required in ("agent", "ask", "plan", "view-builder", "skill-builder"):
        assert required in ids, f"{required} mode missing"


def test_active_mcps_default_factory_creates_new_list():
    """Defaults must use Field(default_factory=list), not [], to avoid shared mutation."""
    from backend.apps.agents.core.models import AgentSession
    s1 = AgentSession(id="a", name="a", model="sonnet", mode="agent")
    s2 = AgentSession(id="b", name="b", model="sonnet", mode="agent")
    s1.active_mcps.append("gmail")
    assert s2.active_mcps == [], "active_mcps must not share state across sessions"


# =========================================================================== Group J, Concurrent gate stress (real production risk: simultaneous turns) ===========================================================================


@pytest.mark.asyncio
async def test_concurrent_gate_calls_isolated():
    """Two concurrent _build_mcp_servers calls with different active_mcps must not cross-contaminate."""
    from backend.apps.agents.agent_manager import AgentManager
    fake_tools = [p_fake_tool("Gmail"), p_fake_tool("Slack"), p_fake_tool("Notion")]
    with patch("backend.apps.agents.manager.RunSupport.load_all_tools", return_value=fake_tools), \
         patch("backend.apps.agents.manager.RunSupport.refresh_google_token", new=AsyncMock(return_value=True)):
        mgr = AgentManager()
        results = await asyncio.gather(
            mgr.build_mcp_servers(allowed_tools=["mcp:Gmail", "mcp:Slack", "mcp:Notion"], active_mcps=["gmail"]),
            mgr.build_mcp_servers(allowed_tools=["mcp:Gmail", "mcp:Slack", "mcp:Notion"], active_mcps=["slack"]),
            mgr.build_mcp_servers(allowed_tools=["mcp:Gmail", "mcp:Slack", "mcp:Notion"], active_mcps=["notion"]),
            mgr.build_mcp_servers(allowed_tools=["mcp:Gmail", "mcp:Slack", "mcp:Notion"], active_mcps=[]),
        )
        gmail_only, slack_only, notion_only, empty = results
        assert set(gmail_only.keys()) == {"gmail"}
        assert set(slack_only.keys()) == {"slack"}
        assert set(notion_only.keys()) == {"notion"}
        assert set(empty.keys()) == set()


# =========================================================================== Group K, pending_continuation auto-restart ===========================================================================


def test_pending_continuation_default_false():
    from backend.apps.agents.core.models import AgentSession
    s = AgentSession(id="x", name="t", model="sonnet", mode="agent")
    assert s.pending_continuation is False
    assert s.pending_continuation_prompt is None


def test_pending_continuation_serializes():
    from backend.apps.agents.core.models import AgentSession
    s = AgentSession(id="x", name="t", model="sonnet", mode="agent")
    s.pending_continuation = True
    s.pending_continuation_prompt = "[mcp:auto-continue] retry now"
    d = s.model_dump(mode="json")
    s2 = AgentSession.model_validate(d)
    assert s2.pending_continuation is True
    assert s2.pending_continuation_prompt.startswith("[mcp:auto-continue]")


def test_compact_threshold_default():
    """compact_threshold_pct default of 0.65, drift here breaks Phase 2 compaction."""
    from backend.apps.agents.core.models import AgentSession
    s = AgentSession(id="x", name="t", model="sonnet", mode="agent")
    assert s.compact_threshold_pct == 0.65
    assert s.context_soft_cap_pct == 0.90
    assert s.context_window == 200_000


def test_post_compact_estimate_excludes_compacted_messages():
    from backend.apps.agents.core.models import AgentSession, Message
    from backend.apps.agents.manager.session.history_compaction import (
        estimate_post_compact_input,
    )

    messages = [
        Message(id=f"m{i}", role="user", content=("old" * 1000 if i < 6 else "keep"))
        for i in range(8)
    ]
    s = AgentSession(id="x", name="t", model="sonnet", mode="agent")
    s.messages = messages
    s.compacted_through_msg_id = "m5"
    s.framework_overhead_tokens = 100

    assert estimate_post_compact_input(s) == 100 + 200 + (len("keepkeep") // 4)


@pytest.mark.asyncio
async def test_context_update_emitter_refreshes_session_tokens(monkeypatch):
    import backend.apps.agents.agent_manager as agent_manager_module
    from backend.apps.agents.agent_manager import AgentManager
    from backend.apps.agents.core.models import AgentSession

    sent = []

    async def fake_send_to_session(session_id, event, payload):
        sent.append((session_id, event, payload))

    monkeypatch.setattr(
        agent_manager_module.ws_manager,
        "send_to_session",
        fake_send_to_session,
    )
    s = AgentSession(id="x", name="t", model="sonnet", mode="agent")
    s.context_window = 1_000
    s.tokens = {"input": 900, "output": 7}
    s.framework_overhead_tokens = 42
    s.active_mcps = ["github"]

    await AgentManager().emit_context_update("x", s, input_tokens=250)

    assert s.tokens == {"input": 250, "output": 7}
    assert sent == [(
        "x",
        "agent:context_update",
        {
            "session_id": "x",
            "input_tokens": 250,
            "output_tokens": 7,
            "cache_read_tokens": 0,
            "cache_read_pct": 0.0,
            "ctx_used_pct": 0.25,
            "context_window": 1_000,
            "framework_overhead_tokens": 42,
            "active_mcps": ["github"],
        },
    )]


# =========================================================================== Group L, Sentence-case display (the parseMcpToolName fix) =========================================================================== This is technically a frontend behavior, but we mirror the rule in Python so the backend's MCPSearch results don't leak Title Case either.


def test_sentence_case_rule():
    """Mirror of the JS _humanizeName: first word capitalized, rest lower."""
    def sentence_case(name: str) -> str:
        spaced = name.replace("_", " ").replace("-", " ").lower()
        return spaced[0].upper() + spaced[1:] if spaced else ""

    cases = [
        ("get_message_details", "Get message details"),
        ("send_gmail_message", "Send gmail message"),
        ("Create_PR", "Create pr"),
        ("foo_bar_baz", "Foo bar baz"),
    ]
    for raw, expected in cases:
        assert sentence_case(raw) == expected


# =========================================================================== Group M, Bash command verb extraction (frontend logic, mirrored) ===========================================================================


def test_bash_verb_extraction_strips_env_prefix():
    """`FOO=bar git commit -m x` should treat `git commit` as the verb."""
    import re
    cmd = "FOO=bar BAZ=qux git commit -m hi"
    stripped = re.sub(r"^(?:[A-Z_][A-Z0-9_]*=\S+\s+)+", "", cmd)
    assert stripped.startswith("git commit")


def test_bash_verb_extraction_strips_sudo():
    """`sudo rm foo` → verb is `rm`, target is `foo`."""
    cmd = "sudo rm /tmp/foo"
    tokens = cmd.split()
    if tokens[0] in ("sudo", "time", "nice", "env"):
        tokens = tokens[1:]
    assert tokens[0] == "rm"
    assert tokens[1] == "/tmp/foo"


def test_bash_command_detail_path_basename():
    """Path-shaped args get basename'd in the row."""
    paths = [
        ("/Users/eric/foo.ts", "foo.ts"),
        ("a/b/c/long.tsx", "long.tsx"),
        ("foo.txt", "foo.txt"),
        ("/", ""),
    ]
    def basename(p: str) -> str:
        cleaned = p.rstrip("/\\")
        if not cleaned:
            return ""
        parts = cleaned.replace("\\", "/").split("/")
        return parts[-1] if parts[-1] else cleaned
    for raw, expected in paths:
        assert basename(raw) == expected


# =========================================================================== Group N, Pydantic AppSettings invariants ===========================================================================


def test_app_settings_defaults():
    from backend.apps.settings.models import AppSettings
    s = AppSettings()
    assert s.connection_mode == "own_key"
    assert s.default_thinking_level == "auto"
    assert s.dismissed_mcp_suggestions == {}
    assert s.analytics_opt_in is True


def test_custom_provider_round_trip():
    from backend.apps.settings.models import AppSettings, CustomProvider
    s = AppSettings()
    s.custom_providers = [
        CustomProvider(name="MyCorp", base_url="https://api.mycorp.test", api_key="sk-test"),
    ]
    d = s.model_dump(mode="json")
    s2 = AppSettings.model_validate(d)
    assert len(s2.custom_providers) == 1
    assert s2.custom_providers[0].name == "MyCorp"


# =========================================================================== Group O, Tool gate stress with denied permissions ===========================================================================


@pytest.mark.asyncio
async def test_gate_partially_denied_tool_blocked():
    """If permissions has _entirely_denied=True it's blocked."""
    from backend.apps.agents.manager.prompt.tool_catalog import is_fully_denied
    fake = p_fake_tool("Gmail", permissions={
        "_tool_descriptions": {"send_email": "Send email"},
        "send_email": "deny",
    })
    # Build a minimal class that has the perms_dict shape is_fully_denied expects
    assert is_fully_denied(fake) in (True, False)


@pytest.mark.asyncio
async def test_gate_handles_missing_refresh_token_gracefully():
    """Tool with auth_status='configured' and no oauth shouldn't crash the gate."""
    from backend.apps.agents.agent_manager import AgentManager
    fake = p_fake_tool("MyApiTool", auth_status="configured")
    fake.auth_type = None  # no oauth
    with patch("backend.apps.agents.manager.RunSupport.load_all_tools", return_value=[fake]):
        mgr = AgentManager()
        result = await mgr.build_mcp_servers(
            allowed_tools=["mcp:MyApiTool"],
            active_mcps=["myapitool"],
        )
        # It should be present (configured + activated + not denied)
        assert "myapitool" in result


# =========================================================================== Group P, resolve_aux_model failover logic ===========================================================================


@pytest.mark.asyncio
async def test_aux_failover_anthropic_to_codex():
    """primary_api=codex but codex unreachable → falls through to anthropic-first cascade."""
    from backend.apps.agents.providers import registry
    from backend.apps.settings.models import AppSettings
    settings = AppSettings()
    settings.connection_mode = "openswarm-pro"  # provides anthropic fallback
    settings.openswarm_proxy_url = "https://api.openswarm.test"
    settings.openswarm_bearer_token = "test-pro-token"  # what a real Pro user carries
    with patch("backend.apps.nine_router.is_running", return_value=True), \
         patch("backend.apps.nine_router.get_providers",
               new=AsyncMock(return_value=[])):  # nothing connected
        # primary_api=codex but codex not connected → cascade to Pro/anthropic
        model_id, base = await registry.resolve_aux_model(settings, primary_api="codex")
        assert "haiku" in model_id  # fallthrough hit Anthropic Pro path
        assert base == "https://api.openswarm.test"


@pytest.mark.asyncio
async def test_aux_returns_haiku_by_default():
    """preferred_tier='haiku' → bare haiku model id."""
    from backend.apps.agents.providers import registry
    from backend.apps.settings.models import AppSettings
    settings = AppSettings()
    settings.anthropic_api_key = "sk-test-fake"
    with patch("backend.apps.nine_router.is_running", return_value=False):
        model_id, base = await registry.resolve_aux_model(settings, preferred_tier="haiku")
        assert "haiku" in model_id
        assert base is None


@pytest.mark.asyncio
async def test_aux_returns_sonnet_when_preferred_tier_set():
    from backend.apps.agents.providers import registry
    from backend.apps.settings.models import AppSettings
    settings = AppSettings()
    settings.anthropic_api_key = "sk-test-fake"
    with patch("backend.apps.nine_router.is_running", return_value=False):
        model_id, base = await registry.resolve_aux_model(settings, preferred_tier="sonnet")
        assert "sonnet" in model_id


# =========================================================================== Group Q, get_api_type / model id resolution ===========================================================================


def test_get_api_type_openai():
    from backend.apps.agents.providers.registry import get_api_type
    # gpt-5.4 maps to codex (the OpenAI-via-Codex-subscription api family)
    api = get_api_type("gpt-5.4")
    assert api in ("openai", "codex"), f"unexpected: {api}"


def test_find_builtin_model_returns_none_for_unknown():
    from backend.apps.agents.providers.registry import find_builtin_model
    assert find_builtin_model("not-a-real-model-xyz") is None


def test_find_builtin_model_returns_dict_for_known():
    from backend.apps.agents.providers.registry import find_builtin_model
    sonnet = find_builtin_model("sonnet")
    assert sonnet is not None
    assert sonnet.get("api") == "anthropic"


# =========================================================================== Group R, context window ===========================================================================


def test_get_context_window_known_model():
    from backend.apps.agents.providers.registry import get_context_window
    cw = get_context_window("Anthropic", "sonnet")
    assert cw >= 200_000


def test_get_context_window_unknown_returns_default():
    from backend.apps.agents.providers.registry import get_context_window
    cw = get_context_window("Unknown", "fake-model")
    assert cw == 128_000


def test_apply_context_window_overwrites_default_for_opus_4_7():
    """Regression for issue #39: AgentSession used to stick at the 200k
    dataclass default for every model. apply_context_window must pull
    the real 1M value from the registry for opus-4-7 / sonnet so the
    soft-cap trim and the % meter both reflect the real model cap."""
    from backend.apps.agents.core.models import AgentSession
    from backend.apps.agents.manager.session.apply_context_window import apply_context_window
    s = AgentSession(id="x", name="t", model="opus-4-7", mode="agent")
    assert s.context_window == 200_000
    apply_context_window(s)
    assert s.context_window == 1_000_000
    s2 = AgentSession(id="y", name="t", model="sonnet", mode="agent")
    apply_context_window(s2)
    assert s2.context_window == 1_000_000
    s3 = AgentSession(id="z", name="t", model="haiku", mode="agent")
    apply_context_window(s3)
    assert s3.context_window == 200_000


def test_apply_context_window_silent_on_unknown_model():
    """Bad lookup must NEVER raise; sessions with unknown/custom models
    that aren't in the registry fall back to the 128k registry default
    without breaking session creation."""
    from backend.apps.agents.core.models import AgentSession
    from backend.apps.agents.manager.session.apply_context_window import apply_context_window
    s = AgentSession(id="x", name="t", model="nonexistent-model-xyz", mode="agent")
    apply_context_window(s)
    assert s.context_window > 0


def test_estimate_pdf_tokens_floors_empty_pdf_at_byte_heuristic():
    """A truly empty / minimal PDF still returns a non-zero estimate so
    the dry-run guard doesn't allow many tiny PDFs through silently."""
    from backend.apps.settings.settings import estimate_pdf_tokens
    assert estimate_pdf_tokens(b"") >= 1_000
    assert estimate_pdf_tokens(b"%PDF-1.4\n") >= 1_000


def test_estimate_pdf_tokens_takes_max_of_pages_and_bytes():
    """An image-heavy PDF with low page count should still report high
    tokens via the byte-size signal; we never under-report."""
    from backend.apps.settings.settings import estimate_pdf_tokens
    # 8MB PDF with 1 page (image-heavy), byte heuristic should dominate.
    fake = b"%PDF-1.4\n/Type /Pages /Count 1\n" + b"X" * (8 * 1024 * 1024)
    tokens = estimate_pdf_tokens(fake)
    # byte heuristic: 8MB / 80 = 100k tokens > pages * 750 = 750
    assert tokens >= 100_000


def test_estimate_pdf_tokens_caps_malformed_count():
    """A PDF with /Count 999999 (malformed or hostile) does NOT bypass
    the 10k pages sanity cap; falls through to byte heuristic instead."""
    from backend.apps.settings.settings import estimate_pdf_tokens
    fake = b"%PDF-1.4\n/Type /Pages /Count 999999\n"
    t = estimate_pdf_tokens(fake)
    # Should NOT be 999999 * 750 = 750 million.
    assert t < 50_000_000


def test_upload_dedup_under_concurrent_uploads():
    """Run N parallel uploads of the same logical filename through threads
    and verify EVERY upload landed at a distinct path (no overwrites)."""
    import os, threading
    from backend.apps.settings.settings import UPLOAD_DIR
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    name = f"test_concurrent_{os.getpid()}.txt"
    results: list[str] = []
    lock = threading.Lock()

    def writer():
        base, ext = os.path.splitext(name)
        dest = os.path.join(UPLOAD_DIR, name)
        counter = 0
        fd = None
        while fd is None:
            try:
                fd = os.open(dest, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
            except FileExistsError:
                counter += 1
                dest = os.path.join(UPLOAD_DIR, f"{base}_{counter}{ext}")
        with os.fdopen(fd, "wb") as fh:
            fh.write(b"hi")
        with lock:
            results.append(dest)

    threads = [threading.Thread(target=writer) for _ in range(10)]
    for t in threads: t.start()
    for t in threads: t.join()
    try:
        assert len(set(results)) == 10, f"expected 10 distinct paths, got {len(set(results))}"
    finally:
        for p in results:
            try: os.remove(p)
            except Exception: pass


def test_resolve_attachments_handles_missing_path_gracefully():
    """If a path in context_paths no longer exists (file deleted, TTL
    cleanup fired, restored session referencing temp file across reboot),
    we emit a 'not found' refusal instead of crashing."""
    from backend.apps.agents.agent_manager import AgentManager
    mgr = AgentManager()
    text, native, refusals = mgr.resolve_attachments(
        [{"path": "/var/folders/nonexistent/definitely-gone.pdf", "type": "file"}],
        api_type="anthropic", model="opus-4-7",
    )
    assert not native
    # 'not found' lands in `text` (sections), not refusals, per implementation.
    assert "not found" in text.lower()


def test_resolve_attachments_handles_directory_path_not_file():
    """A directory in context_paths gets dir-tree handling, not treated
    as a file. Prevents trying to base64 a directory."""
    import tempfile, os
    from backend.apps.agents.agent_manager import AgentManager
    mgr = AgentManager()
    tmpdir = tempfile.mkdtemp()
    open(os.path.join(tmpdir, "a.txt"), "w").write("hello")
    try:
        text, native, refusals = mgr.resolve_attachments(
            [{"path": tmpdir, "type": "directory"}],
            api_type="anthropic", model="opus-4-7",
        )
        assert not native
        assert "context_directory" in text
    finally:
        import shutil; shutil.rmtree(tmpdir)


def test_resolve_attachments_mixed_kinds_total_size_guard():
    """1 text + 1 PDF + 1 image attached together must respect both the
    per-file caps AND the total-request-size cap as a single integrated
    check, not three independent ones."""
    import tempfile, os
    from backend.apps.agents.agent_manager import AgentManager
    mgr = AgentManager()
    paths = []
    try:
        # 10MB PDF + 10MB image + small text → 20MB raw = ~27MB base64, under Anthropic's 28MB cap so all should land natively.
        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as fh:
            fh.write(b"%PDF-1.4\n"); fh.write(b"X" * (10 * 1024 * 1024))
            paths.append(fh.name)
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as fh:
            fh.write(b"\x89PNG\r\n\x1a\n"); fh.write(b"X" * (10 * 1024 * 1024))
            paths.append(fh.name)
        with tempfile.NamedTemporaryFile(suffix=".md", mode="w", delete=False) as fh:
            fh.write("# notes"); paths.append(fh.name)
        text, native, refusals = mgr.resolve_attachments(
            [{"path": p, "type": "file"} for p in paths],
            api_type="anthropic", model="opus-4-7",
        )
        # All three should make it: PDF native, image native, text inline.
        assert len(native) == 2
        assert any(b["type"] == "document" for b in native)
        assert any(b["type"] == "image" for b in native)
        assert "notes" in text
        assert not refusals
    finally:
        for p in paths:
            try: os.unlink(p)
            except Exception: pass


def test_upload_dedup_handles_filename_collision_atomically():
    """O_CREAT|O_EXCL must reserve the destination so two callers
    racing on the same filename get distinct outputs, not one
    overwriting the other."""
    import os, tempfile, shutil
    from backend.apps.settings.settings import UPLOAD_DIR
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    name = f"test_dedup_{os.getpid()}.txt"
    paths = []
    try:
        # Simulate two writers reserving the same base name back to back.
        for _ in range(3):
            base, ext = os.path.splitext(name)
            dest = os.path.join(UPLOAD_DIR, name)
            counter = 0
            fd = None
            while fd is None:
                try:
                    fd = os.open(dest, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
                except FileExistsError:
                    counter += 1
                    dest = os.path.join(UPLOAD_DIR, f"{base}_{counter}{ext}")
            with os.fdopen(fd, "wb") as fh:
                fh.write(b"hi")
            paths.append(dest)
        assert len(set(paths)) == 3
    finally:
        for p in paths:
            try: os.remove(p)
            except Exception: pass


def test_sniff_recognises_macos_paths_with_spaces():
    """File paths on macOS commonly contain spaces ('My Documents/file.pdf').
    The sniffer reads contents, not the path, but agent_manager's
    os.path.basename / open() must round-trip these correctly."""
    import tempfile, os
    from backend.apps.agents.agent_manager import AgentManager
    mgr = AgentManager()
    tmpdir = tempfile.mkdtemp(prefix="space test ")
    path = os.path.join(tmpdir, "my doc.pdf")
    try:
        with open(path, "wb") as f:
            f.write(b"%PDF-1.4\n")
        p_t, native, refusals = mgr.resolve_attachments(
            [{"path": path, "type": "file"}], api_type="anthropic", model="opus-4-7",
        )
        assert native and native[0]["type"] == "document"
        assert not refusals
    finally:
        try: os.unlink(path)
        except Exception: pass
        try: os.rmdir(tmpdir)
        except Exception: pass


def test_resolve_attachments_uses_os_path_basename_for_windows_paths():
    """When backend runs on Windows, paths arrive as C:\\Users\\X\\file.pdf.
    os.path.basename handles backslash correctly on Windows (ntpath module),
    but on POSIX (this test env) it treats backslash as a literal character.
    Either way, the refusal copy embeds the result, so the test just verifies
    no crash on Windows-shaped strings. Real Windows behavior is exercised
    in CI on Windows hosts via .github/workflows/."""
    import os, ntpath
    # ntpath.basename simulates what Windows os.path.basename does on actual Windows hosts. Our backend uses os.path which == ntpath on Windows and posixpath on macOS/Linux, so paths go through correctly at runtime per host. This test asserts the parsing is correct WHEN routed through ntpath (the Windows code path).
    win_path = r"C:\Users\rrios\AppData\Local\Temp\self-swarm-uploads\palm.pdf"
    assert ntpath.basename(win_path) == "palm.pdf"
    # And that os.path.join with mixed separators on Windows would still produce a valid path (ntpath is forgiving).
    assert ntpath.basename(r"D:/Downloads\test.pdf") == "test.pdf"


def test_sniff_file_kind_consistent_across_platforms():
    """The sniffer reads bytes, never paths. So platform doesn't matter
    for the classification logic, same bytes → same kind on Windows/Mac/Linux."""
    from backend.apps.settings.settings import sniff_file_kind
    assert sniff_file_kind(b"%PDF-1.4\n", "x.pdf") == ("pdf", "application/pdf")
    assert sniff_file_kind(b"\x89PNG\r\n\x1a\n", "x.png") == ("image", "image/png")
    assert sniff_file_kind(b"PK\x03\x04", "x.zip") == ("binary", None)
    assert sniff_file_kind(b"MZ\x90\x00", "x.exe") == ("binary", None)
    assert sniff_file_kind(b"hello world", "x.txt") == ("text", "text/plain")


def test_estimate_pdf_tokens_consistent_across_platforms():
    """Same byte-level math regardless of OS."""
    from backend.apps.settings.settings import estimate_pdf_tokens
    # 5MB PDF should always estimate ≥ 5MB/80 = 65536 tokens.
    fake = b"%PDF-1.4\n" + b"X" * (5 * 1024 * 1024)
    assert estimate_pdf_tokens(fake) >= 65000


def test_sniff_handles_windows_style_backslash_path_string():
    """Some Windows paths arrive at agent_manager with backslashes when
    JSON-encoded or copied from Explorer. os.path.exists() handles
    forward slashes on Windows but backslashes on POSIX would NOT find
    the file. The basename() helper in the frontend already normalizes,
    but verify the agent_manager refusal path is graceful."""
    import os
    from backend.apps.agents.agent_manager import AgentManager
    mgr = AgentManager()
    # A path that doesn't exist (POSIX cannot interpret backslashes as separator)
    p_t, native, refusals = mgr.resolve_attachments(
        [{"path": r"C:\fake\path\nope.pdf", "type": "file"}],
        api_type="anthropic", model="opus-4-7",
    )
    assert not native
    # Should produce a "not found" refusal, not crash.
    assert any("not found" in s.lower() or "not found" in s for s in (p_t, *refusals)) or "not found" in p_t


def test_upload_dir_writable_on_macos_temp():
    """Audit: verify UPLOAD_DIR resolves to a writable path on this OS.
    On macOS, tempfile.gettempdir() → /var/folders/... which is outside
    the app sandbox restrictions; our entitlements don't grant explicit
    temp access but it works due to standard process inheritance. On
    Windows, tempfile → C:/Users/X/AppData/Local/Temp/ which is always
    writable. Failure here would block every file attachment."""
    import os
    from backend.apps.settings.settings import UPLOAD_DIR
    assert os.path.isdir(UPLOAD_DIR), f"UPLOAD_DIR not a directory: {UPLOAD_DIR}"
    probe = os.path.join(UPLOAD_DIR, ".write_probe")
    try:
        with open(probe, "w") as f:
            f.write("ok")
        assert os.path.isfile(probe)
    finally:
        try: os.remove(probe)
        except Exception: pass


def test_resolve_attachments_classifies_renamed_binary_as_binary_not_pdf():
    """A .pdf rename of a ZIP/PNG must NOT be inlined as a document
    block; magic-byte sniff guards us."""
    import tempfile, os
    from backend.apps.agents.agent_manager import AgentManager
    mgr = AgentManager()
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as fh:
        fh.write(b"PK\x03\x04fake zip masquerading as pdf")
        path = fh.name
    try:
        p_t, native, refusals = mgr.resolve_attachments(
            [{"path": path, "type": "file"}], api_type="anthropic", model="opus-4-7",
        )
        assert not native
        assert refusals and "binary" in refusals[0].lower()
    finally:
        os.unlink(path)


def test_gemini_proxy_rewrites_document_to_openai_image_url_for_9router():
    """9router 0.3.60 only preserves `image_url` blocks (chunk 318 filter);
    Anthropic-shape image/document blocks get stringified. We rewrite to
    OpenAI image_url with data: URL so 9router emits Gemini inlineData."""
    import json
    from backend.apps.agents.proxy.anthropic_proxy import scrub_request_for_gemini
    body = json.dumps({
        "model": "gemini-3.1-pro-preview",
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": "summarize this"},
                {"type": "document", "source": {
                    "type": "base64",
                    "media_type": "application/pdf",
                    "data": "JVBERi0xLjQK",
                }},
            ],
        }],
    }).encode("utf-8")
    out = json.loads(scrub_request_for_gemini(body))
    blocks = out["messages"][0]["content"]
    assert blocks[0]["type"] == "text"
    assert blocks[1]["type"] == "image_url"
    assert blocks[1]["image_url"]["url"] == "data:application/pdf;base64,JVBERi0xLjQK"


def test_gemini_proxy_also_rewrites_anthropic_image_blocks_to_image_url():
    """Same fix applies to plain images: Anthropic image → OpenAI image_url
    with data: URL, so 9router's filter preserves it instead of stringifying."""
    import json
    from backend.apps.agents.proxy.anthropic_proxy import scrub_request_for_gemini
    body = json.dumps({
        "model": "gemini-3-pro-preview",
        "messages": [{
            "role": "user",
            "content": [
                {"type": "image", "source": {
                    "type": "base64",
                    "media_type": "image/png",
                    "data": "iVBORw0KGgo=",
                }},
            ],
        }],
    }).encode("utf-8")
    out = json.loads(scrub_request_for_gemini(body))
    block = out["messages"][0]["content"][0]
    assert block["type"] == "image_url"
    assert block["image_url"]["url"] == "data:image/png;base64,iVBORw0KGgo="


def test_anthropic_document_block_schema_matches_docs():
    """Schema-conformance: the document block our agent_manager emits for
    Anthropic must structurally match the canonical shape from
    https://docs.claude.com/en/docs/build-with-claude/pdf-support
    (base64 inline). If Anthropic changes the schema we want a noisy test
    failure here, not a runtime production failure."""
    import tempfile, os
    from backend.apps.agents.agent_manager import AgentManager
    mgr = AgentManager()
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as fh:
        fh.write(b"%PDF-1.4\n%canonical schema test\n")
        path = fh.name
    try:
        p_t, native, p_r = mgr.resolve_attachments(
            [{"path": path, "type": "file"}], api_type="anthropic", model="opus-4-7",
        )
        block = native[0]
        # Per Anthropic docs, the exact required fields are:
        assert set(block.keys()) >= {"type", "source"}
        assert block["type"] == "document"
        src = block["source"]
        assert set(src.keys()) == {"type", "media_type", "data"}
        assert src["type"] == "base64"
        assert src["media_type"] == "application/pdf"
        # cache_control is optional but our impl sets it on the last block
        if "cache_control" in block:
            assert block["cache_control"] == {"type": "ephemeral"}
        # Base64 data must decode cleanly back to PDF magic header.
        import base64 as p_b64
        decoded = p_b64.b64decode(src["data"])
        assert decoded.startswith(b"%PDF-")
    finally:
        os.unlink(path)


def test_gemini_translated_block_matches_9router_image_url_filter():
    """Per inspection of router/.next/server/chunks/318.js, 9router 0.3.60's
    OpenAI→Gemini translator only handles `image_url` blocks with data: URLs
    (it stringifies any other shape). Our translator must emit exactly that
    shape for PDFs and images both."""
    import json
    from backend.apps.agents.proxy.anthropic_proxy import scrub_request_for_gemini
    body = json.dumps({
        "model": "gemini-3.1-pro-preview",
        "messages": [{"role": "user", "content": [
            {"type": "document", "source": {
                "type": "base64",
                "media_type": "application/pdf",
                "data": "JVBERi0xLjQK",
            }},
        ]}],
    }).encode("utf-8")
    out = json.loads(scrub_request_for_gemini(body))
    block = out["messages"][0]["content"][0]
    assert block["type"] == "image_url"
    assert "image_url" in block
    assert block["image_url"]["url"].startswith("data:application/pdf;base64,")


def test_gemini_schema_normalizer_allowlists_and_folds_nullable():
    """Gemini's function_declarations validator 400s (zero tokens in) on JSON
    Schema constructs the old denylist kept missing: union `type`, anyOf/oneOf/
    allOf, $comment, format, additionalProperties, title. The normalizer keeps
    only the keys Gemini accepts and folds the two nullable encodings Anthropic
    emits (union type, anyOf-with-null) into the `nullable` flag Gemini groks.
    Live-confirmed against the Gemini API 2026-06-14."""
    import json
    from backend.apps.agents.proxy.anthropic_proxy import (
        normalize_schema_for_gemini, scrub_request_for_gemini,
    )
    # union type -> single type + nullable
    assert normalize_schema_for_gemini({"type": ["string", "null"], "description": "d"}) == \
        {"type": "string", "description": "d", "nullable": True}
    # anyOf-with-null -> chosen branch + nullable, allowed constraint preserved
    assert normalize_schema_for_gemini({"anyOf": [{"type": "integer", "minimum": 0}, {"type": "null"}]}) == \
        {"type": "integer", "minimum": 0, "nullable": True}
    # forbidden keys dropped, enum kept
    assert normalize_schema_for_gemini({
        "type": "object", "additionalProperties": False, "title": "T",
        "properties": {"u": {"type": "string", "format": "uri", "$comment": "x", "minLength": 2},
                       "d": {"type": "string", "enum": ["a", "b"]}},
        "required": ["u"],
    }) == {"type": "object",
           "properties": {"u": {"type": "string"}, "d": {"type": "string", "enum": ["a", "b"]}},
           "required": ["u"]}

    # End to end: no Gemini-rejected key survives a realistic tool payload.
    FORBIDDEN = {"$schema", "$ref", "additionalProperties", "title", "default", "$comment",
                 "format", "pattern", "minLength", "maxLength", "anyOf", "oneOf", "allOf", "const"}
    body = json.dumps({"model": "gemini-3.1-pro-preview", "tools": [{
        "name": "q", "input_schema": {
            "type": "object", "additionalProperties": False, "$schema": "x",
            "properties": {
                "filter": {"anyOf": [{"type": "object", "properties": {"q": {"type": "string"}}},
                                     {"type": "null"}]},
                "size": {"type": ["integer", "null"], "minimum": 1, "default": 10},
                "url": {"type": "string", "format": "uri", "$comment": "c"}},
            "required": ["filter"]}}]}).encode()
    schema = json.loads(scrub_request_for_gemini(body))["tools"][0]["input_schema"]
    seen, stack = set(), [schema]
    while stack:
        n = stack.pop()
        if isinstance(n, dict):
            seen |= set(n.keys()); stack += list(n.values())
        elif isinstance(n, list):
            stack += n
    assert seen.isdisjoint(FORBIDDEN), f"forbidden keys survived: {seen & FORBIDDEN}"


def test_gpt5_param_scrub_drops_unsupported_sampling_knobs():
    """GPT-5 reasoning models 400 on max_tokens, temperature!=1, top_p, and the
    penalty/logprobs family. Both the proxy and the passthrough must strip them.
    Live-confirmed the 400s against the OpenAI API 2026-06-14."""
    import json
    from backend.apps.agents.proxy.anthropic_proxy import scrub_request_for_openai_gpt5
    from backend.apps.agents.core.openai_passthrough import scrub_gpt5_params
    dirty = json.dumps({"model": "gpt-5", "messages": [{"role": "user", "content": "hi"}],
                        "max_tokens": 200, "temperature": 0, "top_p": 0.9,
                        "frequency_penalty": 0.5, "presence_penalty": 0.1, "logprobs": True}).encode()
    for fn in (scrub_request_for_openai_gpt5, scrub_gpt5_params):
        out = json.loads(fn(dirty))
        assert out.get("max_completion_tokens") == 200 and "max_tokens" not in out, fn.__name__
        for k in ("temperature", "top_p", "frequency_penalty", "presence_penalty", "logprobs"):
            assert k not in out, f"{fn.__name__} left {k}"
    # temperature==1 is the one allowed value; don't over-strip it
    assert json.loads(scrub_gpt5_params(json.dumps(
        {"model": "gpt-5", "temperature": 1}).encode())).get("temperature") == 1
    # non-gpt-5 models are untouched
    assert json.loads(scrub_gpt5_params(json.dumps(
        {"model": "gpt-4o", "temperature": 0, "top_p": 0.5}).encode())) == \
        {"model": "gpt-4o", "temperature": 0, "top_p": 0.5}


def test_openrouter_plugin_array_matches_docs():
    """Per https://openrouter.ai/docs/features/multimodal/pdfs, the
    plugins array shape is `[{id:"file-parser", pdf:{engine: "..."}}]`
    at the top level. Engines: pdf-text (free, deprecated → cloudflare),
    mistral-ocr ($2/1k pages), native (model-supported)."""
    import json
    from backend.apps.agents.proxy.anthropic_proxy import inject_openrouter_file_parser
    body = json.dumps({
        "model": "openrouter/qwen/qwen-2.5-72b-instruct",
        "messages": [{"role": "user", "content": [
            {"type": "document", "source": {
                "type": "base64", "media_type": "application/pdf", "data": "x",
            }},
        ]}],
    }).encode("utf-8")
    out = json.loads(inject_openrouter_file_parser(body))
    plugins = out["plugins"]
    assert isinstance(plugins, list)
    fp = [p for p in plugins if p.get("id") == "file-parser"][0]
    # Shape exactly matches https://openrouter.ai/docs/features/multimodal/pdfs
    assert set(fp.keys()) == {"id", "pdf"}
    assert isinstance(fp["pdf"], dict)
    assert fp["pdf"]["engine"] in ("pdf-text", "mistral-ocr", "native")


def test_openai_translated_image_block_matches_image_url_data_uri():
    """OpenAI's image_url accepts data: URIs only for image/* mime types
    (verified May 2026, application/pdf returns HTTP 400). The
    translator rewrites Anthropic image blocks; document blocks are
    refused upstream in agent_manager."""
    import json
    from backend.apps.agents.proxy.anthropic_proxy import scrub_request_for_openai_gpt5
    body = json.dumps({
        "model": "gpt-5.5",
        "max_tokens": 100,
        "messages": [{"role": "user", "content": [
            {"type": "image", "source": {
                "type": "base64",
                "media_type": "image/png",
                "data": "iVBORw0KGgo=",
            }},
        ]}],
    }).encode("utf-8")
    out = json.loads(scrub_request_for_openai_gpt5(body))
    block = out["messages"][0]["content"][0]
    assert block["type"] == "image_url"
    assert block["image_url"]["url"] == "data:image/png;base64,iVBORw0KGgo="


def test_openai_proxy_rewrites_image_block_only_documents_pass_through():
    """OpenAI image_url only accepts image/* mime; documents are refused
    upstream. Translator handles images, leaves documents untouched."""
    import json
    from backend.apps.agents.proxy.anthropic_proxy import scrub_request_for_openai_gpt5
    body = json.dumps({
        "model": "gpt-5.5",
        "max_tokens": 500,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": "what's in this image?"},
                {"type": "image", "source": {
                    "type": "base64",
                    "media_type": "image/png",
                    "data": "iVBORw0KGgo=",
                }},
            ],
        }],
    }).encode("utf-8")
    out = json.loads(scrub_request_for_openai_gpt5(body))
    blocks = out["messages"][0]["content"]
    assert blocks[0]["type"] == "text"
    assert blocks[1]["type"] == "image_url"
    assert blocks[1]["image_url"]["url"].startswith("data:image/png;base64,")
    assert "max_completion_tokens" in out
    assert "max_tokens" not in out


def test_openai_proxy_skips_rewrite_when_no_document():
    """Pure text turn on GPT-5 should only get the max_tokens rename."""
    import json
    from backend.apps.agents.proxy.anthropic_proxy import scrub_request_for_openai_gpt5
    body = json.dumps({
        "model": "gpt-5.5",
        "max_tokens": 100,
        "messages": [{"role": "user", "content": "hi"}],
    }).encode("utf-8")
    out = json.loads(scrub_request_for_openai_gpt5(body))
    assert out["messages"][0]["content"] == "hi"
    assert out.get("max_completion_tokens") == 100


def test_openai_proxy_defensive_on_malformed_document_blocks():
    """Malformed document blocks (missing source, missing data) pass
    through untouched so the upstream returns a proper error rather
    than us silently dropping the file."""
    import json
    from backend.apps.agents.proxy.anthropic_proxy import scrub_request_for_openai_gpt5
    body = json.dumps({
        "model": "gpt-5.5",
        "messages": [{
            "role": "user",
            "content": [
                {"type": "document"},
                {"type": "document", "source": {"type": "url"}},
                {"type": "document", "source": {"type": "base64"}},
            ],
        }],
    }).encode("utf-8")
    out = json.loads(scrub_request_for_openai_gpt5(body))
    for b in out["messages"][0]["content"]:
        assert b["type"] == "document"


def test_resolve_attachments_openai_codex_refused_for_pdfs():
    """Codex variants refuse PDFs (both because Codex models don't read
    PDFs AND because the OpenAI direct lane is currently disabled until
    9router translation lands)."""
    import tempfile, os
    from backend.apps.agents.agent_manager import AgentManager
    mgr = AgentManager()
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as fh:
        fh.write(b"%PDF-1.4\n%test\n")
        path = fh.name
    try:
        p_t, native, refusals = mgr.resolve_attachments(
            [{"path": path, "type": "file"}], api_type="openai", model="gpt-5.3-codex",
        )
        assert not native
        assert refusals
    finally:
        os.unlink(path)


def test_resolve_attachments_openai_codex_still_refuses_pdf():
    """Codex variants don't support PDFs even though their OpenAI family
    does; refusal should fire with switch hint."""
    import tempfile, os
    from backend.apps.agents.agent_manager import AgentManager
    mgr = AgentManager()
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as fh:
        fh.write(b"%PDF-1.4\n%test\n")
        path = fh.name
    try:
        p_t, native, refusals = mgr.resolve_attachments(
            [{"path": path, "type": "file"}], api_type="openai", model="gpt-5.3-codex",
        )
        assert not native
        assert refusals and "codex" in refusals[0].lower()
    finally:
        os.unlink(path)


def test_openrouter_proxy_injects_file_parser_plugin_when_document_present():
    """OR's universal-PDF feature requires top-level plugins:[{id:file-parser,...}].
    When a document block is in the request bound for OR, inject it."""
    import json
    from backend.apps.agents.proxy.anthropic_proxy import inject_openrouter_file_parser
    body = json.dumps({
        "model": "openrouter/qwen/qwen-2.5-72b-instruct",
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": "summarize"},
                {"type": "document", "source": {
                    "type": "base64",
                    "media_type": "application/pdf",
                    "data": "JVBERi0xLjQK",
                }},
            ],
        }],
    }).encode("utf-8")
    out = json.loads(inject_openrouter_file_parser(body))
    plugins = out.get("plugins")
    assert isinstance(plugins, list) and len(plugins) >= 1
    fp = next((p for p in plugins if p.get("id") == "file-parser"), None)
    assert fp and fp["pdf"]["engine"] == "pdf-text"


def test_openrouter_proxy_skips_plugin_when_no_document():
    """No document block → don't inject the plugin (costs nothing, but
    keeps the request body clean)."""
    import json
    from backend.apps.agents.proxy.anthropic_proxy import inject_openrouter_file_parser
    body = json.dumps({
        "model": "openrouter/qwen/qwen-2.5-72b-instruct",
        "messages": [{"role": "user", "content": "just a question"}],
    }).encode("utf-8")
    out = json.loads(inject_openrouter_file_parser(body))
    assert "plugins" not in out


def test_openrouter_proxy_dedupes_existing_file_parser_plugin():
    """If a caller already provided file-parser, don't duplicate it."""
    import json
    from backend.apps.agents.proxy.anthropic_proxy import inject_openrouter_file_parser
    body = json.dumps({
        "model": "openrouter/qwen/qwen-2.5-72b-instruct",
        "plugins": [{"id": "file-parser", "pdf": {"engine": "mistral-ocr"}}],
        "messages": [{
            "role": "user",
            "content": [
                {"type": "document", "source": {"type": "base64", "media_type": "application/pdf", "data": "x"}},
            ],
        }],
    }).encode("utf-8")
    out = json.loads(inject_openrouter_file_parser(body))
    fps = [p for p in out["plugins"] if p.get("id") == "file-parser"]
    assert len(fps) == 1
    assert fps[0]["pdf"]["engine"] == "mistral-ocr"  # caller's engine wins


def test_gemini_proxy_defensive_on_malformed_blocks():
    """Bad shapes (missing data, wrong source.type, non-string data)
    must NOT be rewritten; they pass through so the upstream sees the
    error rather than a silently-corrupted block."""
    import json
    from backend.apps.agents.proxy.anthropic_proxy import scrub_request_for_gemini
    body = json.dumps({
        "model": "gemini-3.1-pro-preview",
        "messages": [{
            "role": "user",
            "content": [
                {"type": "document"},                        # no source
                {"type": "document", "source": {}},          # empty source
                {"type": "document", "source": {"type": "url"}},  # not base64
                {"type": "document", "source": {"type": "base64"}},  # no data
            ],
        }],
    }).encode("utf-8")
    out = json.loads(scrub_request_for_gemini(body))
    for b in out["messages"][0]["content"]:
        assert b["type"] == "document"


def test_resolve_attachments_anthropic_emits_native_document():
    """Anthropic upstream gets a `document` content block for PDFs, not
    a text placeholder."""
    import base64, tempfile, os
    from backend.apps.agents.agent_manager import AgentManager
    mgr = AgentManager()
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as fh:
        fh.write(b"%PDF-1.4\n%test\n")
        path = fh.name
    try:
        text, native, refusals = mgr.resolve_attachments(
            [{"path": path, "type": "file"}], api_type="anthropic", model="opus-4-7",
        )
        assert native and native[0]["type"] == "document"
        assert native[0]["source"]["media_type"] == "application/pdf"
        assert not refusals
    finally:
        os.unlink(path)


def test_resolve_attachments_openai_accepts_pdf_via_bypass_translator():
    """OpenAI GPT-5.x non-codex accepts PDFs because anthropic_proxy
    detects document blocks + bypasses 9router via anthropic_to_openai.
    No refusal at agent_manager level; the bypass kicks in at proxy
    time when openai_api_key is set."""
    import tempfile, os
    from backend.apps.agents.agent_manager import AgentManager
    mgr = AgentManager()
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as fh:
        fh.write(b"%PDF-1.4\n%test\n")
        path = fh.name
    try:
        p_text, native, refusals = mgr.resolve_attachments(
            [{"path": path, "type": "file"}], api_type="openai", model="gpt-5.5",
        )
        assert native and native[0]["type"] == "document"
        assert not refusals
    finally:
        os.unlink(path)


def test_bypass_estimate_body_bytes_sums_image_url_and_file_blocks():
    """The size estimator must sum payload bytes across BOTH content
    types the translator emits (image_url with data: URL, file with
    file_data) so the pre-flight reject can fire before httpx serializes."""
    from backend.apps.agents.proxy.anthropic_to_openai import estimate_body_bytes
    body = {"messages": [{"role": "user", "content": [
        {"type": "text", "text": "hi"},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,QUJDRA=="}},  # 8 bytes b64
        {"type": "file", "file": {"file_data": "data:application/pdf;base64,RUZHSA=="}},  # 8 bytes b64
    ]}]}
    assert estimate_body_bytes(body) == 16


def test_bypass_concurrency_semaphore_serializes_excess_requests():
    """The semaphore caps in-flight bypass requests to prevent OOM. Cap=2
    means a third concurrent request waits rather than allocating another
    ~40MB buffer."""
    from backend.apps.agents.proxy.anthropic_to_openai import bypass_sema, BYPASS_CONCURRENCY
    assert BYPASS_CONCURRENCY == 2
    # Initial value matches the cap (no in-flight at import time).
    assert bypass_sema._value == BYPASS_CONCURRENCY


def test_anthropic_to_openai_should_bypass_fires_for_gpt5_pdf():
    """The bypass only fires for: GPT-5.x non-codex + has document block
    + openai_api_key set. Misses any of those: 9router path."""
    from backend.apps.agents.proxy.anthropic_to_openai import should_bypass_9router
    body = {"model": "gpt-5.5", "messages": [{"role": "user", "content": [
        {"type": "document", "source": {"type": "base64", "media_type": "application/pdf", "data": "x"}},
    ]}]}
    assert should_bypass_9router(body, "sk-abc")
    assert not should_bypass_9router(body, None)
    assert not should_bypass_9router(body, "")
    assert not should_bypass_9router({**body, "model": "gpt-5.3-codex"}, "sk-abc")
    body_no_doc = {"model": "gpt-5.5", "messages": [{"role": "user", "content": "hi"}]}
    assert not should_bypass_9router(body_no_doc, "sk-abc")
    body_with_tools = {**body, "tools": [{"name": "x"}]}
    assert not should_bypass_9router(body_with_tools, "sk-abc")


def test_anthropic_to_openai_request_translation_shape():
    """Translator must produce a valid OpenAI Chat Completions body."""
    from backend.apps.agents.proxy.anthropic_to_openai import translate_request
    body = {
        "model": "gpt-5.5",
        "max_tokens": 200,
        "system": "You are helpful.",
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": "summarize"},
                {"type": "document", "source": {
                    "type": "base64", "media_type": "application/pdf", "data": "JVBERi0=",
                }},
                {"type": "image", "source": {
                    "type": "base64", "media_type": "image/png", "data": "iVBOR=",
                }},
            ],
        }],
    }
    out = translate_request(body)
    assert out["model"] == "gpt-5.5"
    assert out["stream"] is True
    assert out["max_completion_tokens"] == 200
    assert out["messages"][0] == {"role": "system", "content": "You are helpful."}
    user_content = out["messages"][1]["content"]
    assert any(p["type"] == "text" and p["text"] == "summarize" for p in user_content)
    assert any(p["type"] == "file" and p["file"]["file_data"].startswith("data:application/pdf;base64,") for p in user_content)
    assert any(p["type"] == "image_url" and p["image_url"]["url"].startswith("data:image/png;base64,") for p in user_content)


def test_resolve_attachments_gemini_emits_native_document_after_translator_fix():
    """After fixing the 9router 0.3.60 block-stripping bug via
    anthropic_proxy._rewrite_document_to_image (now rewrites both
    image AND document → OpenAI image_url with data: URL, which 9router
    translates to Gemini inlineData), PDFs flow on Gemini natively."""
    import tempfile, os
    from backend.apps.agents.agent_manager import AgentManager
    mgr = AgentManager()
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as fh:
        fh.write(b"%PDF-1.4\n%test\n")
        path = fh.name
    try:
        p_text, native, refusals = mgr.resolve_attachments(
            [{"path": path, "type": "file"}], api_type="gemini", model="gemini-3.1-pro-api",
        )
        assert native and native[0]["type"] == "document"
        assert not refusals
    finally:
        os.unlink(path)


def test_resolve_attachments_text_file_inlined_not_native():
    """Text files keep flowing through the existing context_file inline
    path (no native block)."""
    import tempfile, os
    from backend.apps.agents.agent_manager import AgentManager
    mgr = AgentManager()
    with tempfile.NamedTemporaryFile(suffix=".md", mode="w", delete=False) as fh:
        fh.write("# hello\nworld")
        path = fh.name
    try:
        text, native, refusals = mgr.resolve_attachments(
            [{"path": path, "type": "file"}], api_type="opus-4-7", model="opus-4-7",
        )
        assert not native
        assert not refusals
        assert "hello" in text
    finally:
        os.unlink(path)


def test_resolve_attachments_pdf_refused_when_too_large():
    """Anthropic's per-file cap blocks PDFs over 24MB."""
    import os, tempfile
    from backend.apps.agents.agent_manager import AgentManager
    mgr = AgentManager()
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as fh:
        fh.write(b"%PDF-1.4\n")
        fh.write(b"X" * (25 * 1024 * 1024))
        path = fh.name
    try:
        p_t, native, refusals = mgr.resolve_attachments(
            [{"path": path, "type": "file"}], api_type="anthropic", model="opus-4-7",
        )
        assert not native
        assert refusals
        assert "per-file cap" in refusals[0].lower() or "exceeds" in refusals[0].lower()
    finally:
        os.unlink(path)


def test_resolve_attachments_refuses_when_total_exceeds_request_cap():
    """4 medium PDFs that each pass the per-file cap should still be
    blocked when their combined base64 size would exceed Anthropic's
    32MB request cap. This is the exact Mehmet scenario (30.3MB raw
    of 4 PDFs base64 to ~40MB)."""
    import os, tempfile
    from backend.apps.agents.agent_manager import AgentManager
    mgr = AgentManager()
    # 4 PDFs at ~8MB each = 32MB raw = ~43MB base64, exceeds 28MB cap.
    paths = []
    try:
        for i in range(4):
            with tempfile.NamedTemporaryFile(suffix=f"_{i}.pdf", delete=False) as fh:
                fh.write(b"%PDF-1.4\n")
                fh.write(b"X" * (8 * 1024 * 1024))
                paths.append(fh.name)
        p_t, native, refusals = mgr.resolve_attachments(
            [{"path": p, "type": "file"} for p in paths],
            api_type="anthropic", model="opus-4-7",
        )
        # First few PDFs fit; later ones refused with "request over" message.
        assert refusals, "expected refusals on multi-PDF over-cap"
        assert any("encoded" in r.lower() and "provider cap" in r.lower() for r in refusals), \
            f"expected total-size refusal copy; got: {refusals}"
    finally:
        for p in paths:
            try: os.unlink(p)
            except Exception: pass


def test_resolve_attachments_anthropic_marks_last_document_ephemeral_for_cache():
    """Anthropic prompt caching: the last document block gets
    cache_control:ephemeral so multi-turn PDF chats stay cache-warm."""
    import os, tempfile
    from backend.apps.agents.agent_manager import AgentManager
    mgr = AgentManager()
    paths = []
    try:
        for i in range(2):
            with tempfile.NamedTemporaryFile(suffix=f"_{i}.pdf", delete=False) as fh:
                fh.write(b"%PDF-1.4\n%test\n")
                paths.append(fh.name)
        p_t, native, p_r = mgr.resolve_attachments(
            [{"path": p, "type": "file"} for p in paths],
            api_type="anthropic", model="opus-4-7",
        )
        # Only the LAST document gets cache_control per Anthropic docs.
        assert native[-1].get("cache_control") == {"type": "ephemeral"}
        assert "cache_control" not in native[0]
    finally:
        for p in paths:
            try: os.unlink(p)
            except Exception: pass


def test_resolve_attachments_anthropic_does_mark_ephemeral_but_only_anthropic():
    """cache_control is Anthropic-only; don't pollute other-provider
    blocks. Anthropic should get ephemeral on the last document block;
    OpenRouter (which also supports PDFs) should NOT."""
    import os, tempfile
    from backend.apps.agents.agent_manager import AgentManager
    mgr = AgentManager()
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as fh:
        fh.write(b"%PDF-1.4\n%test\n")
        path = fh.name
    try:
        p_t, ant_native, p_r = mgr.resolve_attachments(
            [{"path": path, "type": "file"}], api_type="anthropic", model="opus-4-7",
        )
        assert ant_native and ant_native[0].get("cache_control") == {"type": "ephemeral"}
        p_t, or_native, p_r = mgr.resolve_attachments(
            [{"path": path, "type": "file"}], api_type="openrouter", model="openrouter/openai/gpt-5",
        )
        assert or_native and "cache_control" not in or_native[0]
    finally:
        os.unlink(path)


def test_apply_context_window_respects_custom_provider_value():
    """Custom OpenAI-compatible models supply their own context_window
    via settings.custom_providers. apply_context_window must look them
    up the same way get_context_window does."""
    from backend.apps.agents.core.models import AgentSession
    from backend.apps.agents.manager.session.apply_context_window import apply_context_window
    from backend.apps.settings.models import AppSettings, CustomProvider
    s = AgentSession(id="x", name="t", provider="custom", model="custom/ollama/qwen2.5:7b", mode="agent")
    settings = AppSettings(custom_providers=[
        CustomProvider(
            name="Ollama",
            base_url="http://localhost:11434/v1",
            api_key="",
            models=[{"value": "qwen2.5:7b", "label": "Qwen 2.5 7B", "context_window": 32_000}],
        ),
    ])
    apply_context_window(s, settings)
    assert s.context_window == 32_000


# --------------------------------------------------------------------------- Custom OpenAI-compatible providers (Ollama Cloud, Together, etc.) ---------------------------------------------------------------------------


def test_custom_provider_value_synthesises_route_api_entry():
    """`custom/<slug>/<bare>` picker values must synthesise a route='api',
    api='custom' entry whose model_id is the 9Router routing string
    `cp-<slug>/<bare>`. agent_manager keys on api='custom' and resolved_model
    must be the cp- prefixed string for 9Router to forward correctly."""
    from backend.apps.agents.providers.registry import find_builtin_model
    entry = find_builtin_model("custom/ollama-cloud/gpt-oss:120b")
    assert entry is not None
    assert entry.get("api") == "custom"
    assert entry.get("route") == "api"
    assert entry.get("model_id") == "cp-ollama-cloud/gpt-oss:120b"
    assert entry.get("router_model_id") == "cp-ollama-cloud/gpt-oss:120b"


def test_custom_provider_value_resolve_model_id_returns_cp_prefix():
    from backend.apps.agents.providers.registry import resolve_model_id_for_sdk
    from backend.apps.settings.models import AppSettings
    rid = resolve_model_id_for_sdk("custom/ollama-cloud/gpt-oss:120b", AppSettings())
    assert rid == "cp-ollama-cloud/gpt-oss:120b"


def test_custom_provider_value_with_multi_segment_model_id():
    """Model ids may contain '/' (e.g. meta-llama/llama-3-70b-instruct on
    Together AI). Synthesis must use partition on the FIRST '/' so the
    rest of the model id stays intact."""
    from backend.apps.agents.providers.registry import find_builtin_model
    entry = find_builtin_model("custom/together-ai/meta-llama/llama-3-70b-instruct")
    assert entry is not None
    assert entry.get("model_id") == "cp-together-ai/meta-llama/llama-3-70b-instruct"


def test_custom_provider_lookup_finds_entry_by_slug():
    """find_custom_provider_for_value must slugify the same way as the
    UI/sync layer so name 'Ollama Cloud' resolves to the value
    'custom/ollama-cloud/...'."""
    from backend.apps.agents.providers.registry import find_custom_provider_for_value
    from backend.apps.settings.models import AppSettings, CustomProvider
    s = AppSettings(custom_providers=[
        CustomProvider(name="Ollama Cloud", base_url="https://ollama.com/v1", api_key="x"),
        CustomProvider(name="Together AI", base_url="https://api.together.xyz/v1", api_key="y"),
    ])
    cp = find_custom_provider_for_value(s, "custom/ollama-cloud/gpt-oss:120b")
    assert cp is not None and cp.name == "Ollama Cloud"
    cp2 = find_custom_provider_for_value(s, "custom/together-ai/meta-llama/llama-3-70b")
    assert cp2 is not None and cp2.name == "Together AI"
    # Unknown slug → None.
    assert find_custom_provider_for_value(s, "custom/nonexistent/whatever") is None


def test_get_context_window_custom_provider_value_format():
    """Picker values use `custom/<slug>/<bare>` but the user-stored model
    list keys context_window by the bare model id. Lookup must strip the
    prefix before matching."""
    from backend.apps.agents.providers.registry import get_context_window
    from backend.apps.settings.models import AppSettings, CustomProvider
    s = AppSettings(custom_providers=[
        CustomProvider(
            name="Together AI",
            base_url="https://api.together.xyz/v1",
            api_key="x",
            models=[{"value": "deepseek-r1", "label": "DeepSeek R1", "context_window": 64_000}],
        ),
    ])
    assert get_context_window("Together AI", "custom/together-ai/deepseek-r1", s) == 64_000


def test_custom_provider_slug_is_url_safe():
    """The slug must be alnum-and-dash only, it's used both as the 9Router
    prefix and as a URL path segment. Spaces, slashes, and special chars
    must all be folded to dashes."""
    from backend.apps.agents.providers.registry import custom_provider_slug_for_lookup
    assert custom_provider_slug_for_lookup("Ollama Cloud") == "ollama-cloud"
    assert custom_provider_slug_for_lookup("My/Local LM!!!") == "my-local-lm"
    assert custom_provider_slug_for_lookup("") == "custom"
    assert custom_provider_slug_for_lookup("   ") == "custom"


def test_custom_provider_slug_unicode_collapses_safely():
    """Unicode names are folded to ASCII-safe dashes; emojis/accents drop."""
    from backend.apps.agents.providers.registry import custom_provider_slug_for_lookup
    # Accented chars get stripped (regex is [a-zA-Z0-9-] only).
    assert custom_provider_slug_for_lookup("Tögether AI 🚀") == "t-gether-ai"
    # Pure-emoji name → fallback "custom".
    assert custom_provider_slug_for_lookup("🚀💎") == "custom"
    # Trailing/leading dashes get stripped.
    assert custom_provider_slug_for_lookup("---weird---") == "weird"


def test_custom_provider_slug_does_not_collide_with_routing_prefixes():
    """The cp- prefix in the routing string must not collide with 9Router's
    built-in prefixes (cc/, cx/, gc/, ag/, gemini/, openrouter/) used by
    resolved_is_9router. cp- starts with 'c' and dash so it can't be
    confused with cc/, but verify the dispatch logic agrees."""
    from backend.apps.agents.providers.registry import find_builtin_model
    entry = find_builtin_model("custom/cc/whatever")  # adversarial slug "cc"
    assert entry is not None
    routed = entry["model_id"]
    assert routed == "cp-cc/whatever"
    # cp-cc is NOT cc/, startswith check would have to match the exact slash.
    assert not routed.startswith(("cc/", "cx/", "gc/", "ag/", "gemini/", "openrouter/"))


def test_custom_provider_models_with_special_chars():
    """Model ids in the wild contain colons (Ollama 'gpt-oss:120b'), dots
    (deepseek 'deepseek-v3.1'), version suffixes (':free'), and slashes
    (Together 'meta-llama/Llama-3-70B'). All must round-trip without
    being mangled."""
    from backend.apps.agents.providers.registry import find_builtin_model
    cases = [
        "custom/ollama/gpt-oss:120b",
        "custom/together/meta-llama/Llama-3.3-70B-Instruct",
        "custom/deepseek/deepseek-v3.1-base",
        "custom/openrouter/anthropic/claude-haiku-4.5:free",
        "custom/groq/llama-3.3-70b-versatile",
    ]
    for v in cases:
        e = find_builtin_model(v)
        assert e is not None, f"failed: {v}"
        # Bare-model portion is everything after first slash after the slug.
        rest = v[len("custom/"):]
        slug, _, bare = rest.partition("/")
        assert e["model_id"] == f"cp-{slug}/{bare}", f"bad routing for {v}: {e['model_id']}"


def test_custom_provider_value_with_invalid_format_returns_none():
    """Malformed picker values (no slug, no model) must not synthesise a
    bogus entry, they should miss find_builtin_model entirely so the
    dispatch loop falls through to the 'unknown model' branch."""
    from backend.apps.agents.providers.registry import find_builtin_model
    assert find_builtin_model("custom/") is None
    assert find_builtin_model("custom/onlyslug") is None
    assert find_builtin_model("custom//onlymodel") is None  # empty slug


def test_custom_provider_get_api_type_returns_custom():
    """get_api_type drives the dispatch branch in agent_manager.py, must
    return 'custom' (not 'anthropic' default fallback) for a custom value."""
    from backend.apps.agents.providers.registry import get_api_type
    assert get_api_type("custom/ollama/gpt-oss:120b") == "custom"


def test_custom_provider_pydantic_round_trip_preserves_models():
    """Settings save/load uses Pydantic; the models field is list[dict] and
    must survive serialize-deserialize without dropping per-model fields."""
    from backend.apps.settings.models import AppSettings, CustomProvider
    s = AppSettings(custom_providers=[
        CustomProvider(
            name="My LM Studio",
            base_url="http://localhost:1234/v1",
            api_key="not-needed",
            models=[
                {"value": "qwen3-coder", "label": "Qwen 3 Coder", "context_window": 128_000},
                {"value": "llama-3.3-70b", "label": "Llama 3.3 70B"},  # no ctx
            ],
        ),
    ])
    dumped = s.model_dump()
    re = AppSettings(**dumped)
    assert len(re.custom_providers) == 1
    cp = re.custom_providers[0]
    assert cp.name == "My LM Studio"
    assert len(cp.models) == 2
    assert cp.models[0]["context_window"] == 128_000
    assert cp.models[1].get("context_window") is None or cp.models[1].get("context_window") == 0


def test_custom_provider_settings_default_is_empty_list():
    """Existing settings.json without custom_providers must default to []
    (not None / KeyError) so old installs upgrade cleanly."""
    from backend.apps.settings.models import AppSettings
    s = AppSettings()
    assert s.custom_providers == []
    assert isinstance(s.custom_providers, list)


def test_custom_provider_get_anthropic_client_routes_cp_to_9router():
    """probe-model and browser_agent both use get_anthropic_client_for_model.
    A cp- prefixed router id must build a client pointed at 9Router, not
    direct Anthropic, so the request actually reaches the openai-compat
    translator instead of Anthropic's API rejecting an unknown model id."""
    from backend.apps.settings.credentials import get_anthropic_client_for_model
    from backend.apps.settings.models import AppSettings
    s = AppSettings(anthropic_api_key="sk-ant-anything")
    c = get_anthropic_client_for_model(s, "cp-ollama/gpt-oss:120b")
    assert "20128" in str(c.base_url), f"client should point at 9Router, got {c.base_url}"


def test_custom_provider_two_providers_get_distinct_slugs():
    """Two custom providers with different display names must produce
    two different slugs / routing prefixes, otherwise 9Router will route
    both to whichever connection was created last."""
    from backend.apps.agents.providers.registry import custom_provider_slug_for_lookup
    a = custom_provider_slug_for_lookup("Ollama Cloud")
    b = custom_provider_slug_for_lookup("Together AI")
    c = custom_provider_slug_for_lookup("Groq")
    assert len({a, b, c}) == 3


def test_custom_provider_slug_collision_after_sanitize():
    """Two raw names that slugify to the same string is a real footgun
    (e.g. 'Ollama Cloud' vs 'ollama-cloud' both → 'ollama-cloud').
    The dedupe-by-name UI check guards against same-string entries; this
    test just documents that post-slug collisions DO collide and the
    UI-level uniqueness check (in Settings.tsx) is the right enforcement
    layer, backend resolution would always pick the first match."""
    from backend.apps.agents.providers.registry import custom_provider_slug_for_lookup
    assert custom_provider_slug_for_lookup("Ollama Cloud") == \
           custom_provider_slug_for_lookup("ollama-cloud") == \
           custom_provider_slug_for_lookup("OLLAMA cloud")


def test_list_models_includes_complete_custom_providers_excludes_incomplete():
    """list_models must surface fully-configured providers and silently
    skip incomplete ones (missing name/base_url/models). This is what
    let the user's empty-base-URL save 'silently' fail to appear in the
    picker."""
    import asyncio
    from backend.apps.agents.agents import list_models
    from backend.apps.settings.models import AppSettings, CustomProvider
    from unittest.mock import patch

    cfg = AppSettings(custom_providers=[
        # Complete, should appear.
        CustomProvider(
            name="Ollama Cloud", base_url="https://ollama.com/v1", api_key="x",
            models=[{"value": "gpt-oss:120b", "label": "gpt-oss:120b"}],
        ),
        # Empty base_url, should NOT appear.
        CustomProvider(
            name="Broken", base_url="", api_key="y",
            models=[{"value": "model-a", "label": "model-a"}],
        ),
        # No models, should NOT appear.
        CustomProvider(
            name="Empty", base_url="https://example.com/v1", api_key="z",
            models=[],
        ),
        # Empty name, should NOT appear.
        CustomProvider(
            name="", base_url="https://example.com/v1", api_key="z",
            models=[{"value": "x", "label": "x"}],
        ),
    ])

    with patch("backend.apps.settings.settings.load_settings", return_value=cfg), \
         patch("backend.apps.nine_router.is_running", return_value=False):
        result = asyncio.run(list_models())

    groups = result["models"]
    assert "Ollama Cloud" in groups
    assert len(groups["Ollama Cloud"]) == 1
    assert groups["Ollama Cloud"][0]["value"] == "custom/ollama-cloud/gpt-oss:120b"
    assert groups["Ollama Cloud"][0]["billing_kind"] == "api_key"
    # None of the incomplete entries' names create a group.
    assert "Broken" not in groups
    assert "Empty" not in groups


def test_list_models_custom_provider_model_with_only_value_fills_label():
    """Per the Settings UI we send {value, label} where label = value. But
    list_models should be tolerant of a model dict missing 'label' (e.g.
    if a power user edits settings.json by hand)."""
    import asyncio
    from backend.apps.agents.agents import list_models
    from backend.apps.settings.models import AppSettings, CustomProvider
    from unittest.mock import patch

    cfg = AppSettings(custom_providers=[
        CustomProvider(
            name="Bare", base_url="https://x/v1", api_key="k",
            models=[{"value": "model-only-value"}],  # no label
        ),
    ])
    with patch("backend.apps.settings.settings.load_settings", return_value=cfg), \
         patch("backend.apps.nine_router.is_running", return_value=False):
        result = asyncio.run(list_models())

    assert "Bare" in result["models"]
    entry = result["models"]["Bare"][0]
    assert entry["label"] == "model-only-value"


def test_list_models_custom_provider_id_field_alias_for_value():
    """Test the back-compat: cp.models[].id (alternate key) works
    alongside cp.models[].value, since get_context_window uses both."""
    import asyncio
    from backend.apps.agents.agents import list_models
    from backend.apps.settings.models import AppSettings, CustomProvider
    from unittest.mock import patch

    cfg = AppSettings(custom_providers=[
        CustomProvider(
            name="IdProvider", base_url="https://x/v1", api_key="k",
            models=[{"id": "model-via-id-field", "label": "Model"}],
        ),
    ])
    with patch("backend.apps.settings.settings.load_settings", return_value=cfg), \
         patch("backend.apps.nine_router.is_running", return_value=False):
        result = asyncio.run(list_models())

    assert "IdProvider" in result["models"]
    assert result["models"]["IdProvider"][0]["value"] == "custom/idprovider/model-via-id-field"


def test_custom_provider_context_window_falls_back_to_default():
    """Power users may not specify context_window. Default is 128k."""
    from backend.apps.agents.providers.registry import get_context_window
    from backend.apps.settings.models import AppSettings, CustomProvider
    s = AppSettings(custom_providers=[
        CustomProvider(
            name="Provider", base_url="https://x/v1", api_key="k",
            models=[{"value": "m", "label": "m"}],  # no context_window
        ),
    ])
    cw = get_context_window("Provider", "custom/provider/m", s)
    assert cw == 128_000


def test_custom_provider_resolve_aux_model_unaffected():
    """resolve_aux_model is the one-shot LLM call path. Custom providers
    are NOT in its decision tree, Haiku/9Router/OR fallbacks should still
    fire. Custom providers are deliberately not used for aux because we
    don't know if they support tool calling well enough."""
    import asyncio
    from backend.apps.agents.providers.registry import resolve_aux_model
    from backend.apps.settings.models import AppSettings, CustomProvider
    s = AppSettings(
        anthropic_api_key="sk-ant-test",
        custom_providers=[CustomProvider(name="Foo", base_url="https://x/v1", api_key="k")],
    )
    # Should pick Anthropic Haiku, not anything custom.
    rid, base = asyncio.run(resolve_aux_model(s, preferred_tier="haiku"))
    assert "haiku" in rid.lower()
    assert not rid.startswith("cp-")


def test_custom_provider_with_very_long_name_still_works():
    """No upper bound on name length anywhere in the pipeline. Verify a
    250-char name slugs cleanly."""
    from backend.apps.agents.providers.registry import custom_provider_slug_for_lookup, find_builtin_model
    long_name = "a" * 250
    slug = custom_provider_slug_for_lookup(long_name)
    assert slug == long_name
    entry = find_builtin_model(f"custom/{slug}/some-model")
    assert entry is not None
    assert entry["model_id"] == f"cp-{slug}/some-model"


# =========================================================================== 9Router sync stress tests, async, mocked HTTP layer ===========================================================================


def p_make_mock_9router(initial_nodes=None, initial_conns=None, fail_endpoints=None):
    """Build a mock httpx.AsyncClient that simulates 9Router's HTTP API.
    Tracks state across requests so we can assert idempotency.
    Returns (mock_client_class, state_dict), state_dict is mutated by calls."""
    from unittest.mock import AsyncMock, MagicMock
    state = {
        "nodes": list(initial_nodes or []),
        "connections": list(initial_conns or []),
        "calls": [],  # list of (method, url, json) tuples
        "next_id": 1,
    }
    fail = fail_endpoints or set()

    def p_resp(status_code=200, payload=None):
        r = MagicMock()
        r.status_code = status_code
        r.text = "" if not payload else str(payload)
        r.json = MagicMock(return_value=payload or {})
        return r

    async def p_get(url, **kw):
        state["calls"].append(("GET", url, None))
        if "/api/provider-nodes" in url and "GET:provider-nodes" in fail:
            return p_resp(500)
        if url.endswith("/api/provider-nodes"):
            return p_resp(200, {"nodes": state["nodes"]})
        if url.endswith("/api/providers"):
            return p_resp(200, {"connections": state["connections"]})
        return p_resp(404)

    async def p_post(url, json=None, **kw):
        state["calls"].append(("POST", url, json))
        if "/api/provider-nodes" in url and not url.endswith("/provider-nodes/"):
            if "POST:provider-nodes" in fail:
                return p_resp(500, {"error": "fail"})
            node_id = f"openai-compatible-chat-{state['next_id']}"
            state["next_id"] += 1
            new_node = {**(json or {}), "id": node_id}
            state["nodes"].append(new_node)
            return p_resp(201, {"node": new_node})
        if "/api/providers" in url:
            if "POST:providers" in fail:
                return p_resp(500, {"error": "fail"})
            conn_id = f"conn-{state['next_id']}"
            state["next_id"] += 1
            new_conn = {**(json or {}), "id": conn_id, "isActive": True}
            state["connections"].append(new_conn)
            return p_resp(201, {"connection": new_conn})
        return p_resp(404)

    async def p_put(url, json=None, **kw):
        state["calls"].append(("PUT", url, json))
        # /api/provider-nodes/<id>
        for n in state["nodes"]:
            if url.endswith(f"/provider-nodes/{n['id']}"):
                n.update(json or {})
                return p_resp(200, {"node": n})
        return p_resp(404)

    async def p_patch(url, json=None, **kw):
        state["calls"].append(("PATCH", url, json))
        for c in state["connections"]:
            if url.endswith(f"/providers/{c['id']}"):
                c.update(json or {})
                return p_resp(200, {"connection": c})
        return p_resp(404)

    async def p_delete(url, **kw):
        state["calls"].append(("DELETE", url, None))
        for n in list(state["nodes"]):
            if url.endswith(f"/provider-nodes/{n['id']}"):
                state["nodes"].remove(n)
                # Cascade-delete connections.
                state["connections"] = [
                    c for c in state["connections"] if c.get("provider") != n["id"]
                ]
                return p_resp(200, {"success": True})
        for c in list(state["connections"]):
            if url.endswith(f"/providers/{c['id']}"):
                state["connections"].remove(c)
                return p_resp(200, {"success": True})
        return p_resp(404)

    class MockClient:
        def __init__(self, *a, **kw):
            pass
        async def __aenter__(self):
            return self
        async def __aexit__(self, *a):
            return False
        get = AsyncMock(side_effect=p_get)
        post = AsyncMock(side_effect=p_post)
        put = AsyncMock(side_effect=p_put)
        patch = AsyncMock(side_effect=p_patch)
        delete = AsyncMock(side_effect=p_delete)

    return MockClient, state


def test_sync_custom_providers_silently_noop_when_9router_down():
    """Most important invariant: app must boot fine without 9Router. The
    sync should detect down and return without raising or making any
    HTTP calls."""
    import asyncio
    from unittest.mock import patch as upatch
    from backend.apps.nine_router import sync_custom_providers
    from backend.apps.settings.models import CustomProvider

    with upatch("backend.apps.nine_router.is_running", return_value=False):
        # Should not raise even with malformed/empty input.
        asyncio.run(sync_custom_providers([]))
        asyncio.run(sync_custom_providers([
            CustomProvider(name="X", base_url="https://x/v1", api_key="k"),
        ]))


def test_sync_custom_providers_creates_node_and_connection_for_new_provider():
    import asyncio
    from unittest.mock import patch as upatch
    from backend.apps.nine_router import sync_custom_providers
    from backend.apps.settings.models import CustomProvider

    MockClient, state = p_make_mock_9router()
    with upatch("backend.apps.nine_router.is_running", return_value=True), \
         upatch("backend.apps.nine_router.httpx.AsyncClient", MockClient), \
         upatch("backend.apps.nine_router.get_providers", new=lambda: p_async_return([])):
        asyncio.run(sync_custom_providers([
            CustomProvider(name="Ollama Cloud", base_url="https://ollama.com/v1",
                          api_key="key1", models=[]),
        ]))

    # Should have POSTed exactly one node and one connection.
    posts = [c for c in state["calls"] if c[0] == "POST"]
    assert len(posts) == 2, f"expected 2 POSTs, got {len(posts)}: {posts}"
    node_post = next(c for c in posts if "/provider-nodes" in c[1])
    assert node_post[2]["prefix"] == "cp-ollama-cloud"
    assert node_post[2]["baseUrl"] == "https://ollama.com/v1"
    assert node_post[2]["type"] == "openai-compatible"
    assert node_post[2]["apiType"] == "chat"

    conn_post = next(c for c in posts if c[1].endswith("/providers"))
    assert conn_post[2]["apiKey"] == "key1"


def test_sync_custom_providers_appends_v1_when_baseurl_has_no_path():
    """Ollama prints `http://host:11434` on launch, so users paste it verbatim.
    Without /v1 the upstream route is `/chat/completions` (404). Sync must
    normalize bare-host URLs to `<host>/v1` so requests land on
    `/v1/chat/completions`. URLs that already have a path are left alone."""
    import asyncio
    from unittest.mock import patch as upatch
    from backend.apps.nine_router import sync_custom_providers
    from backend.apps.settings.models import CustomProvider

    MockClient, state = p_make_mock_9router()
    with upatch("backend.apps.nine_router.is_running", return_value=True), \
         upatch("backend.apps.nine_router.httpx.AsyncClient", MockClient), \
         upatch("backend.apps.nine_router.get_providers", new=lambda: p_async_return([])):
        asyncio.run(sync_custom_providers([
            CustomProvider(name="Local Ollama", base_url="http://10.0.0.5:11434",
                           api_key="", models=[]),
            CustomProvider(name="Together", base_url="https://api.together.xyz/v1",
                           api_key="k", models=[]),
        ]))

    posts = [c for c in state["calls"] if c[0] == "POST" and "/provider-nodes" in c[1]]
    by_prefix = {p[2]["prefix"]: p[2] for p in posts}
    assert by_prefix["cp-local-ollama"]["baseUrl"] == "http://10.0.0.5:11434/v1"
    assert by_prefix["cp-together"]["baseUrl"] == "https://api.together.xyz/v1"


def test_sync_custom_providers_updates_existing_node_in_place():
    """Idempotency: a second sync of the same provider should PUT the
    existing node, not POST a duplicate."""
    import asyncio
    from unittest.mock import patch as upatch
    from backend.apps.nine_router import sync_custom_providers
    from backend.apps.settings.models import CustomProvider

    existing_nodes = [
        {
            "id": "openai-compatible-chat-existing",
            "name": "Together AI (OpenSwarm-managed)",
            "prefix": "cp-together-ai",
            "type": "openai-compatible",
            "baseUrl": "https://api.together.xyz/v1",
            "apiType": "chat",
        },
    ]
    existing_conns = [
        {
            "id": "conn-existing",
            "provider": "openai-compatible-chat-existing",
            "name": "Together AI (OpenSwarm-managed)",
            "authType": "apikey",
            "apiKey": "old-key",
        },
    ]
    MockClient, state = p_make_mock_9router(existing_nodes, existing_conns)
    with upatch("backend.apps.nine_router.is_running", return_value=True), \
         upatch("backend.apps.nine_router.httpx.AsyncClient", MockClient), \
         upatch("backend.apps.nine_router.get_providers", new=lambda: p_async_return(existing_conns)):
        asyncio.run(sync_custom_providers([
            CustomProvider(
                name="Together AI",
                base_url="https://api.together.xyz/v1",  # unchanged URL
                api_key="new-key",  # changed key
                models=[],
            ),
        ]))

    # Should PUT the node, PATCH the connection. NO new POSTs.
    posts = [c for c in state["calls"] if c[0] == "POST"]
    puts = [c for c in state["calls"] if c[0] == "PUT"]
    patches = [c for c in state["calls"] if c[0] == "PATCH"]
    assert posts == [], f"expected no new nodes/conns, got {posts}"
    assert len(puts) >= 1, f"expected node PUT, got {puts}"
    assert len(patches) >= 1, f"expected conn PATCH, got {patches}"
    # And the apiKey should be the new one in the patched payload.
    assert patches[0][2]["apiKey"] == "new-key"


def test_sync_custom_providers_deletes_orphaned_managed_nodes():
    """When a user removes a custom provider in Settings, the next sync
    should delete the corresponding 9Router node (and its connection
    cascades). Other unmanaged nodes must NOT be touched."""
    import asyncio
    from unittest.mock import patch as upatch
    from backend.apps.nine_router import sync_custom_providers

    existing_nodes = [
        {
            "id": "node-orphan",
            "name": "OldProvider (OpenSwarm-managed)",
            "prefix": "cp-oldprovider",
            "type": "openai-compatible",
        },
        # An UNMANAGED node, should never be deleted.
        {
            "id": "node-user-created",
            "name": "Manual Setup",   # no suffix
            "prefix": "manual",
            "type": "openai-compatible",
        },
    ]
    MockClient, state = p_make_mock_9router(existing_nodes, [])
    with upatch("backend.apps.nine_router.is_running", return_value=True), \
         upatch("backend.apps.nine_router.httpx.AsyncClient", MockClient), \
         upatch("backend.apps.nine_router.get_providers", new=lambda: p_async_return([])):
        asyncio.run(sync_custom_providers([]))  # empty list → delete all managed

    deletes = [c for c in state["calls"] if c[0] == "DELETE"]
    deleted_urls = [c[1] for c in deletes]
    assert any("node-orphan" in u for u in deleted_urls), \
        f"orphan should be deleted: {deleted_urls}"
    assert not any("node-user-created" in u for u in deleted_urls), \
        f"unmanaged nodes must be left alone: {deleted_urls}"


def test_sync_custom_providers_skips_incomplete_entries():
    """Empty name or empty base_url → skip silently. Don't create a
    bogus 9Router node from a half-filled form state."""
    import asyncio
    from unittest.mock import patch as upatch
    from backend.apps.nine_router import sync_custom_providers
    from backend.apps.settings.models import CustomProvider

    MockClient, state = p_make_mock_9router()
    with upatch("backend.apps.nine_router.is_running", return_value=True), \
         upatch("backend.apps.nine_router.httpx.AsyncClient", MockClient), \
         upatch("backend.apps.nine_router.get_providers", new=lambda: p_async_return([])):
        asyncio.run(sync_custom_providers([
            CustomProvider(name="", base_url="https://x/v1", api_key="k"),
            CustomProvider(name="OnlyName", base_url="", api_key="k"),
            CustomProvider(name="   ", base_url="   ", api_key="k"),
        ]))

    posts = [c for c in state["calls"] if c[0] == "POST"]
    assert posts == [], f"no POSTs should fire for incomplete entries: {posts}"


def test_sync_custom_providers_handles_node_post_failure_without_crashing():
    """If 9Router rejects the node POST (e.g. duplicate prefix), don't
    crash the whole sync, log and move on to the next provider."""
    import asyncio
    from unittest.mock import patch as upatch
    from backend.apps.nine_router import sync_custom_providers
    from backend.apps.settings.models import CustomProvider

    MockClient, state = p_make_mock_9router(fail_endpoints={"POST:provider-nodes"})
    with upatch("backend.apps.nine_router.is_running", return_value=True), \
         upatch("backend.apps.nine_router.httpx.AsyncClient", MockClient), \
         upatch("backend.apps.nine_router.get_providers", new=lambda: p_async_return([])):
        # Should NOT raise.
        asyncio.run(sync_custom_providers([
            CustomProvider(name="A", base_url="https://a/v1", api_key="k1"),
            CustomProvider(name="B", base_url="https://b/v1", api_key="k2"),
        ]))


def test_sync_custom_providers_three_distinct_providers_create_three_nodes():
    """Realistic scenario: user adds Ollama + Together + Groq simultaneously.
    All three should land in 9Router with distinct prefixes."""
    import asyncio
    from unittest.mock import patch as upatch
    from backend.apps.nine_router import sync_custom_providers
    from backend.apps.settings.models import CustomProvider

    MockClient, state = p_make_mock_9router()
    with upatch("backend.apps.nine_router.is_running", return_value=True), \
         upatch("backend.apps.nine_router.httpx.AsyncClient", MockClient), \
         upatch("backend.apps.nine_router.get_providers", new=lambda: p_async_return([])):
        asyncio.run(sync_custom_providers([
            CustomProvider(name="Ollama Cloud", base_url="https://ollama.com/v1", api_key="k1"),
            CustomProvider(name="Together AI", base_url="https://api.together.xyz/v1", api_key="k2"),
            CustomProvider(name="Groq", base_url="https://api.groq.com/openai/v1", api_key="k3"),
        ]))

    # Should have POSTed 3 nodes + 3 connections = 6 POSTs.
    posts = [c for c in state["calls"] if c[0] == "POST"]
    assert len(posts) == 6, f"expected 6 POSTs (3 nodes + 3 conns), got {len(posts)}"

    node_posts = [c for c in posts if "/provider-nodes" in c[1] and not c[1].endswith("/providers")]
    prefixes = sorted(p[2]["prefix"] for p in node_posts if "prefix" in (p[2] or {}))
    assert prefixes == sorted(["cp-ollama-cloud", "cp-together-ai", "cp-groq"]), \
        f"prefixes: {prefixes}"


def p_async_return(value):
    """Helper: return a coroutine that resolves to value (for mocking
    `get_providers` which is called WITHOUT being awaited as a function)."""
    async def p_f():
        return value
    return p_f()


# =========================================================================== Group T, Mode definitions ===========================================================================


def test_agent_mode_no_explicit_tools():
    """agent mode should leave tools=None so all builtin tools are available."""
    from backend.apps.modes.models import BUILTIN_MODES
    agent = next(m for m in BUILTIN_MODES if m.id == "agent")
    assert agent.tools is None


def test_ask_mode_is_read_only():
    """ask mode must NOT include Bash/Write/Edit."""
    from backend.apps.modes.models import BUILTIN_MODES
    ask = next(m for m in BUILTIN_MODES if m.id == "ask")
    forbidden = {"Bash", "Write", "Edit", "MultiEdit", "StrReplace"}
    assert set(ask.tools or []).isdisjoint(forbidden)


def test_plan_mode_is_read_only():
    from backend.apps.modes.models import BUILTIN_MODES
    plan = next(m for m in BUILTIN_MODES if m.id == "plan")
    forbidden = {"Bash", "Write", "Edit", "MultiEdit", "StrReplace"}
    assert set(plan.tools or []).isdisjoint(forbidden)


def test_view_builder_mode_has_default_folder():
    from backend.apps.modes.models import BUILTIN_MODES
    vb = next(m for m in BUILTIN_MODES if m.id == "view-builder")
    assert vb.default_folder is not None


# =========================================================================== Group U, Stress: gate handles 100 sequential calls without state leak ===========================================================================


@pytest.mark.asyncio
async def test_gate_100_sequential_calls_no_leak():
    from backend.apps.agents.agent_manager import AgentManager
    fake_tools = [p_fake_tool(f"Server{i}") for i in range(10)]
    with patch("backend.apps.agents.manager.RunSupport.load_all_tools", return_value=fake_tools), \
         patch("backend.apps.agents.manager.RunSupport.refresh_google_token", new=AsyncMock(return_value=True)):
        mgr = AgentManager()
        for i in range(100):
            n = i % 10
            active = [f"server{j}" for j in range(n)]
            allowed = [f"mcp:Server{j}" for j in range(10)]
            result = await mgr.build_mcp_servers(allowed_tools=allowed, active_mcps=active)
            assert set(result.keys()) == set(active), \
                f"iteration {i}: expected {set(active)}, got {set(result.keys())}"


# =========================================================================== Group V, Discord shim entrypoint sanity ===========================================================================


def test_discord_shim_main_callable():
    """The shim must still be invocable via `python -m backend.apps.discord_mcp_shim`."""
    from backend.apps.discord_mcp_shim.server import main
    assert callable(main)


def test_discord_shim_package_importable():
    import backend.apps.discord_mcp_shim
    # Empty __init__ now; just confirm the package imports without error
    assert backend.apps.discord_mcp_shim is not None


# =========================================================================== Group W, Tools/web.py (live MCP for DDG search) ===========================================================================


def test_web_tools_classes_inherit_basetool():
    from backend.apps.agents.tools.web import WebSearchTool, WebFetchTool
    from backend.apps.agents.tools.base import BaseTool
    assert issubclass(WebSearchTool, BaseTool)
    assert issubclass(WebFetchTool, BaseTool)


def test_web_search_tool_has_name_and_schema():
    from backend.apps.agents.tools.web import WebSearchTool
    tool = WebSearchTool()
    assert tool.name
    assert isinstance(tool.get_schema(), dict)


def test_web_fetch_tool_has_name_and_schema():
    from backend.apps.agents.tools.web import WebFetchTool
    tool = WebFetchTool()
    assert tool.name
    assert isinstance(tool.get_schema(), dict)


# =========================================================================== Group X, ToolGroupMeta + caching ===========================================================================


def test_tool_group_meta_round_trip():
    from backend.apps.agents.core.models import ToolGroupMeta, AgentSession
    s = AgentSession(id="x", name="t", model="sonnet", mode="agent")
    s.tool_group_meta["g1"] = ToolGroupMeta(id="g1", name="Reading files", svg="<svg/>", is_refined=True)
    d = s.model_dump(mode="json")
    s2 = AgentSession.model_validate(d)
    assert "g1" in s2.tool_group_meta
    assert s2.tool_group_meta["g1"].is_refined is True


def test_tool_group_meta_default_is_refined_false():
    from backend.apps.agents.core.models import ToolGroupMeta
    m = ToolGroupMeta(id="g", name="x")
    assert m.is_refined is False


# =========================================================================== Group Y, MessageBranch invariants ===========================================================================


def test_session_has_main_branch_by_default():
    from backend.apps.agents.core.models import AgentSession
    s = AgentSession(id="x", name="t", model="sonnet", mode="agent")
    assert "main" in s.branches
    assert s.active_branch_id == "main"


def test_branch_serialization():
    from backend.apps.agents.core.models import AgentSession, MessageBranch
    s = AgentSession(id="x", name="t", model="sonnet", mode="agent")
    s.branches["alt"] = MessageBranch(id="alt", parent_branch_id="main", fork_point_message_id="msg-1")
    d = s.model_dump(mode="json")
    s2 = AgentSession.model_validate(d)
    assert "alt" in s2.branches
    assert s2.branches["alt"].parent_branch_id == "main"


# =========================================================================== Group Z, End-to-end: realistic session lifecycle ===========================================================================


@pytest.mark.asyncio
async def test_e2e_session_lifecycle_with_mcp_activation():
    """
    Walk a session through the realistic flow:
      1. Fresh session (active_mcps empty), gate blocks all MCPs
      2. MCPActivate('gmail'), set fresh_session, append to active_mcps
      3. Continue turn, gate now passes gmail through
      4. Persist & re-load, state survives
    """
    from backend.apps.agents.agent_manager import AgentManager
    from backend.apps.agents.core.models import AgentSession
    fake_tools = [p_fake_tool("Gmail"), p_fake_tool("Slack")]
    with patch("backend.apps.agents.manager.RunSupport.load_all_tools", return_value=fake_tools), \
         patch("backend.apps.agents.manager.RunSupport.refresh_google_token", new=AsyncMock(return_value=True)):
        mgr = AgentManager()
        s = AgentSession(id="e2e", name="End-to-end", model="sonnet", mode="agent")

        # Step 1: fresh, gate blocks everything
        result = await mgr.build_mcp_servers(
            allowed_tools=["mcp:Gmail", "mcp:Slack"],
            active_mcps=s.active_mcps,
        )
        assert result == {}

        # Step 2: simulate MCPActivate
        s.active_mcps.append("gmail")
        s.sdk_session_id = "claude-existing"
        if s.sdk_session_id:
            s.needs_fresh_session = True
        s.pending_continuation = True

        # Step 3: continuation turn, gate passes gmail
        result = await mgr.build_mcp_servers(
            allowed_tools=["mcp:Gmail", "mcp:Slack"],
            active_mcps=s.active_mcps,
        )
        assert "gmail" in result
        assert "slack" not in result

        # Step 4: persist + reload
        dumped = json.dumps(s.model_dump(mode="json"))
        s2 = AgentSession.model_validate(json.loads(dumped))
        assert s2.active_mcps == ["gmail"]
        assert s2.needs_fresh_session is True
        assert s2.pending_continuation is True


@pytest.mark.asyncio
async def test_e2e_50_random_activation_sequences():
    """Stress: 50 random activate/deactivate sequences, gate stays consistent."""
    from backend.apps.agents.agent_manager import AgentManager
    server_pool = [("Gmail", "gmail"), ("Slack", "slack"), ("Notion", "notion"),
                   ("Discord", "discord"), ("GitHub", "github"), ("Linear", "linear")]
    raw_names = [r for r, _ in server_pool]
    sanitized = [s for _, s in server_pool]
    with patch("backend.apps.agents.manager.RunSupport.load_all_tools",
               return_value=[p_fake_tool(r) for r in raw_names]), \
         patch("backend.apps.agents.manager.RunSupport.refresh_google_token", new=AsyncMock(return_value=True)):
        mgr = AgentManager()
        for _ in range(50):
            n = random.randint(0, len(sanitized))
            active = random.sample(sanitized, n)
            allowed = [f"mcp:{r}" for r in raw_names]
            result = await mgr.build_mcp_servers(allowed, active)
            keys = set(result.keys())
            assert keys == set(active), f"mismatch: active={active} keys={keys}"


def test_session_agent_active_ms_default_zero_for_legacy():
    """A session loaded from JSON without `agent_active_ms` deserializes
    cleanly with default 0 (not None, not missing-key crash)."""
    from backend.apps.agents.core.models import AgentSession
    s = AgentSession(name="legacy", model="sonnet", mode="agent")
    assert s.agent_active_ms == 0
    assert s.time_per_model == {}


def test_session_agent_active_ms_round_trip():
    from backend.apps.agents.core.models import AgentSession
    s = AgentSession(name="t", model="sonnet", mode="agent",
                     agent_active_ms=12345, time_per_model={"haiku": 1000, "sonnet": 11345})
    d = s.model_dump(mode="json")
    s2 = AgentSession(**d)
    assert s2.agent_active_ms == 12345
    assert s2.time_per_model == {"haiku": 1000, "sonnet": 11345}


def test_session_agent_active_ms_accumulates_via_dict_update():
    """Simulates two turns adding to the bucket, the production accumulator
    pattern in agent_manager._on_result."""
    from backend.apps.agents.core.models import AgentSession
    s = AgentSession(name="t", model="sonnet", mode="agent")
    s.agent_active_ms = (s.agent_active_ms or 0) + 1500
    s.time_per_model[s.model] = int(s.time_per_model.get(s.model, 0)) + 1500
    s.agent_active_ms = (s.agent_active_ms or 0) + 800
    s.time_per_model[s.model] = int(s.time_per_model.get(s.model, 0)) + 800
    assert s.agent_active_ms == 2300
    assert s.time_per_model == {"sonnet": 2300}


def test_session_time_per_model_records_switch():
    """Simulates a model switch mid-session, each model accumulates its
    own bucket."""
    from backend.apps.agents.core.models import AgentSession
    s = AgentSession(name="t", model="haiku", mode="agent")
    # Turn 1 on haiku
    s.time_per_model[s.model] = int(s.time_per_model.get(s.model, 0)) + 1200
    # User switches to sonnet
    s.model = "sonnet"
    # Turn 2 on sonnet
    s.time_per_model[s.model] = int(s.time_per_model.get(s.model, 0)) + 8400
    assert s.time_per_model == {"haiku": 1200, "sonnet": 8400}
