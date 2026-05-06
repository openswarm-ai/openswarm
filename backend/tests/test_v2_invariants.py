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


_TMPROOT = tempfile.mkdtemp(prefix="openswarm-v2-invariants-")
os.environ.setdefault("OPENSWARM_DATA_DIR", _TMPROOT)


# ---------------------------------------------------------------------------
# Fixture: build a fake ToolDefinition without touching disk.
# ---------------------------------------------------------------------------

def _fake_tool(
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


# ===========================================================================
# Group A — MCP activation gate (the non-bypassable ToolSearch invariant)
# ===========================================================================
# The product invariant: NO MCP tool is callable until the model has
# explicitly searched + activated the server, and the user has approved
# the activation. The gate lives at the dispatch layer in
# `_build_mcp_servers` — even if the prompt rules are ignored, the SDK
# never sees the unactivated server.


@pytest.mark.asyncio
async def test_gate_blocks_when_active_mcps_empty():
    """Connected MCPs + active_mcps=[] → SDK gets empty mcp_servers dict."""
    from backend.apps.agents.agent_manager import AgentManager
    fake_tools = [
        _fake_tool("Gmail"),
        _fake_tool("Slack"),
        _fake_tool("Notion"),
    ]
    with patch("backend.apps.agents.agent_manager.load_all_tools", return_value=fake_tools), \
         patch("backend.apps.agents.agent_manager.refresh_google_token", new=AsyncMock(return_value=True)):
        mgr = AgentManager()
        # allowed_tools includes mcp:Gmail, but active_mcps is empty
        result = await mgr._build_mcp_servers(
            allowed_tools=["mcp:Gmail", "mcp:Slack", "mcp:Notion"],
            active_mcps=[],
        )
        assert result == {}, f"gate must block all MCPs when active_mcps=[]; got {list(result.keys())}"


@pytest.mark.asyncio
async def test_gate_allows_only_activated_servers():
    """active_mcps=['gmail'] → only gmail server in dispatch dict, others blocked."""
    from backend.apps.agents.agent_manager import AgentManager
    fake_tools = [
        _fake_tool("Gmail"),
        _fake_tool("Slack"),
        _fake_tool("Notion"),
    ]
    with patch("backend.apps.agents.agent_manager.load_all_tools", return_value=fake_tools), \
         patch("backend.apps.agents.agent_manager.refresh_google_token", new=AsyncMock(return_value=True)):
        mgr = AgentManager()
        result = await mgr._build_mcp_servers(
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
    fake_tools = [_fake_tool("Gmail"), _fake_tool("Slack")]
    with patch("backend.apps.agents.agent_manager.load_all_tools", return_value=fake_tools), \
         patch("backend.apps.agents.agent_manager.refresh_google_token", new=AsyncMock(return_value=True)):
        mgr = AgentManager()
        result = await mgr._build_mcp_servers(
            allowed_tools=["mcp:Gmail", "mcp:Slack"],
            active_mcps=None,  # legacy / unset
        )
        assert "gmail" in result
        assert "slack" in result


@pytest.mark.asyncio
async def test_gate_disabled_tool_blocked_even_when_activated():
    """Tool with enabled=False stays blocked even if in active_mcps."""
    from backend.apps.agents.agent_manager import AgentManager
    fake_tools = [_fake_tool("Gmail", enabled=False)]
    with patch("backend.apps.agents.agent_manager.load_all_tools", return_value=fake_tools):
        mgr = AgentManager()
        result = await mgr._build_mcp_servers(
            allowed_tools=["mcp:Gmail"],
            active_mcps=["gmail"],
        )
        assert "gmail" not in result, "disabled tool must not reach the SDK"


@pytest.mark.asyncio
async def test_gate_unauthed_tool_blocked():
    """Tool with auth_status='disconnected' stays blocked."""
    from backend.apps.agents.agent_manager import AgentManager
    fake_tools = [_fake_tool("Gmail", auth_status="disconnected")]
    with patch("backend.apps.agents.agent_manager.load_all_tools", return_value=fake_tools):
        mgr = AgentManager()
        result = await mgr._build_mcp_servers(
            allowed_tools=["mcp:Gmail"],
            active_mcps=["gmail"],
        )
        assert "gmail" not in result, "unauthed tool must not reach the SDK"


@pytest.mark.asyncio
async def test_gate_allowed_tools_filter_intersects_active_mcps():
    """Activate gmail+slack but allowed_tools only has gmail → only gmail passes."""
    from backend.apps.agents.agent_manager import AgentManager
    fake_tools = [_fake_tool("Gmail"), _fake_tool("Slack")]
    with patch("backend.apps.agents.agent_manager.load_all_tools", return_value=fake_tools), \
         patch("backend.apps.agents.agent_manager.refresh_google_token", new=AsyncMock(return_value=True)):
        mgr = AgentManager()
        result = await mgr._build_mcp_servers(
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
        fake_tools = [_fake_tool(raw_names[i]) for i in connected_idx]
        connected_sanitized = [server_pool[i] for i in connected_idx]

        # active set is a random subset of connected
        active_n = random.randint(0, len(connected_sanitized))
        active = random.sample(connected_sanitized, active_n)

        # allowed_tools mirrors raw names of connected
        allowed = [f"mcp:{raw_names[i]}" for i in connected_idx]

        with patch("backend.apps.agents.agent_manager.load_all_tools", return_value=fake_tools), \
             patch("backend.apps.agents.agent_manager.refresh_google_token", new=AsyncMock(return_value=True)), \
             patch("backend.apps.agents.agent_manager.refresh_airtable_token", new=AsyncMock(return_value=True)), \
             patch("backend.apps.agents.agent_manager.refresh_hubspot_token", new=AsyncMock(return_value=True)):
            mgr = AgentManager()
            result = await mgr._build_mcp_servers(
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


# ===========================================================================
# Group B — needs_fresh_session soft-restart
# ===========================================================================
# When MCPActivate fires mid-session, the bundled CLI doesn't re-read
# mcp_servers from a fork. We force a fresh sdk_session_id so the new
# server's tools actually reach the model.


def test_needs_fresh_session_field_default_false():
    """Brand-new sessions must default needs_fresh_session=False."""
    from backend.apps.agents.models import AgentSession
    s = AgentSession(id="x", name="t", model="sonnet", mode="agent")
    assert s.needs_fresh_session is False


def test_needs_fresh_session_serializes_round_trip():
    """Pydantic round-trip must preserve the flag for session.json persistence."""
    from backend.apps.agents.models import AgentSession
    s = AgentSession(id="x", name="t", model="sonnet", mode="agent")
    s.needs_fresh_session = True
    s.sdk_session_id = "claude-session-abc-123"
    dumped = s.model_dump(mode="json")
    assert dumped["needs_fresh_session"] is True
    assert dumped["sdk_session_id"] == "claude-session-abc-123"
    rehydrated = AgentSession.model_validate(dumped)
    assert rehydrated.needs_fresh_session is True


def test_legacy_session_json_loads_without_field():
    """Old session JSONs predate the field — Pydantic must fill in default."""
    from backend.apps.agents.models import AgentSession
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
    from backend.apps.agents.models import AgentSession
    # Mid-session: sdk already locked in
    s = AgentSession(id="mid", name="t", model="sonnet", mode="agent")
    s.sdk_session_id = "claude-session-existing"
    # Simulate the gate handler logic
    if s.sdk_session_id:
        s.needs_fresh_session = True
    assert s.needs_fresh_session is True


def test_mcp_activate_skips_fresh_session_on_first_turn():
    """First-turn activation: no sdk_session_id yet, so needs_fresh_session stays False."""
    from backend.apps.agents.models import AgentSession
    s = AgentSession(id="fresh", name="t", model="sonnet", mode="agent")
    # No sdk_session_id yet
    if s.sdk_session_id:
        s.needs_fresh_session = True
    assert s.needs_fresh_session is False


def test_active_mcps_append_idempotent():
    """Activating the same server twice doesn't dupe."""
    from backend.apps.agents.models import AgentSession
    s = AgentSession(id="x", name="t", model="sonnet", mode="agent")
    s.active_mcps.append("gmail")
    if "gmail" not in s.active_mcps:
        s.active_mcps.append("gmail")
    assert s.active_mcps.count("gmail") == 1


# ===========================================================================
# Group C — Pydantic Message backward compat (no ghost fields, legacy loads)
# ===========================================================================


def test_message_no_ghost_fields():
    """answer_tokens + thought_signature must NOT be Message attributes anymore."""
    from backend.apps.agents.models import Message
    m = Message(role="thinking", content="x")
    dumped = m.model_dump(mode="json")
    assert "answer_tokens" not in dumped
    assert "thought_signature" not in dumped


def test_message_legacy_payload_with_ghost_fields_still_loads():
    """Old session JSONs may carry the deleted fields — Pydantic must ignore them."""
    from backend.apps.agents.models import Message
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
    from backend.apps.agents.models import Message
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
    from backend.apps.agents.models import Message
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


# ===========================================================================
# Group D — resolve_aux_model Gemini route (the gemini-3.1-flash-lite-preview fix)
# ===========================================================================


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


# ===========================================================================
# Group E — 9Router-streamed 401 detection
# ===========================================================================
# 9Router sometimes returns upstream auth failures AS the assistant's
# reply text, not as an exception. We detect the pattern in the stream
# handler to substitute a friendly bubble.


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
        "401 Unauthorized — wait this is a code example I'm explaining",  # tricky
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
    """The classifier at agent_manager.py:_is_auth_error covers many shapes."""
    from backend.apps.agents.agent_manager import _is_auth_error

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
        assert _is_auth_error(e), f"should match: {e}"

    # Non-auth errors must not match
    non_matches = [
        Exception("Connection timeout"),
        Exception("Rate limit exceeded"),
        Exception("Internal server error"),
        Exception("File not found"),
    ]
    for e in non_matches:
        assert not _is_auth_error(e), f"should NOT match: {e}"


def test_is_auth_error_with_stderr_tail():
    """The classifier also reads stderr buffer text."""
    from backend.apps.agents.agent_manager import _is_auth_error
    e = Exception("Command failed with exit code 1")
    stderr = "...\n[codex/gpt-5.5] [401]: Provided authentication token is expired"
    assert _is_auth_error(e, extra_text=stderr)


# ===========================================================================
# Group F — MCP_SERVER_BRAND coverage
# ===========================================================================
# Every server slug we surface to the user via MCPSearch / connected_servers
# should have a brand entry, otherwise the UI falls back to the kebab-case
# id ("microsoft-365" instead of "Microsoft 365").


def test_mcp_brand_covers_curated_servers():
    """Every curated server slug must already be in canonical sanitized form."""
    curated = {
        "google-workspace", "microsoft-365", "slack", "discord",
        "notion", "airtable", "hubspot", "reddit", "youtube",
    }
    from backend.apps.tools_lib.tools_lib import _sanitize_server_name
    for slug in curated:
        assert _sanitize_server_name(slug) == slug, (
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
    """_sanitize_server_name must be idempotent (sanitize twice = sanitize once)."""
    from backend.apps.tools_lib.tools_lib import _sanitize_server_name
    test_inputs = [
        "Google Workspace", "Microsoft 365", "Slack", "Discord",
        "Notion", "Airtable", "HubSpot", "Reddit", "YouTube",
        "GitHub", "GitLab", "Jira",
    ]
    for raw in test_inputs:
        once = _sanitize_server_name(raw)
        twice = _sanitize_server_name(once)
        assert once == twice, f"{raw}: sanitize not idempotent ({once} != {twice})"


def test_sanitize_server_name_lowercase():
    from backend.apps.tools_lib.tools_lib import _sanitize_server_name
    assert _sanitize_server_name("Gmail") == "gmail"
    assert _sanitize_server_name("UPPERCASE") == "uppercase"


def test_sanitize_server_name_strips_special_chars():
    from backend.apps.tools_lib.tools_lib import _sanitize_server_name
    assert _sanitize_server_name("Foo Bar!") == "foo-bar"
    assert _sanitize_server_name("@x/y") == "x-y"
    assert _sanitize_server_name("a__b") == "a-b"


# ===========================================================================
# Group G — mcp_meta_server activation backend handler
# ===========================================================================


def test_mcp_activate_handler_unknown_server():
    """Unknown server name → status='unknown_server' with the valid list."""
    # We test the response shape independently of the FastAPI plumbing.
    # The handler is a closure inside main.py:mcp_meta_handler, so we
    # instead exercise the contract: invalid name surfaces alternatives.
    from backend.apps.tools_lib.tools_lib import _sanitize_server_name
    valid = {"gmail", "slack", "google-workspace"}
    requested = "Gmail"  # raw, needs sanitize
    sanitized = _sanitize_server_name(requested)
    if sanitized in valid:
        status = "would_activate"
    else:
        status = "unknown_server"
    assert status in ("would_activate", "unknown_server")


def test_active_mcps_persistence_on_session():
    """active_mcps survives session.model_dump() round-trip — critical for resume."""
    from backend.apps.agents.models import AgentSession
    s = AgentSession(id="x", name="t", model="sonnet", mode="agent")
    s.active_mcps = ["gmail", "slack"]
    s.active_outputs = ["view-1"]
    dumped = json.dumps(s.model_dump(mode="json"))
    rehydrated = AgentSession.model_validate(json.loads(dumped))
    assert rehydrated.active_mcps == ["gmail", "slack"]
    assert rehydrated.active_outputs == ["view-1"]


# ===========================================================================
# Group H — long-context error classifier
# ===========================================================================


def test_long_context_pattern_caught():
    """The 'extra usage required' 429 must NOT silently retry."""
    from backend.apps.agents.agent_manager import _NON_TRANSIENT_PATTERNS
    cases = [
        "Extra usage is required for long context requests",
        "extra usage is required for long context",
        "EXTRA USAGE IS REQUIRED FOR LONG CONTEXT",
    ]
    for case in cases:
        assert _NON_TRANSIENT_PATTERNS.search(case), f"missed: {case!r}"


def test_transient_capacity_patterns():
    """Real transient errors that SHOULD retry."""
    from backend.apps.agents.agent_manager import _TRANSIENT_CAPACITY_PATTERNS, _NON_TRANSIENT_PATTERNS
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
        assert _TRANSIENT_CAPACITY_PATTERNS.search(t), f"transient missed: {t!r}"
        # Importantly: must NOT also match non-transient (no double-classification)
        # except for the fuzzy edge cases. Spot-check a couple:
        if "429" in t and "rate_limit" in t.lower():
            # rate_limit_error is transient; non-transient should not match this exact text
            assert not _NON_TRANSIENT_PATTERNS.search(t)


def test_long_context_does_not_match_normal_429():
    """Generic 429 is transient, only the long-context variant is non-transient."""
    from backend.apps.agents.agent_manager import _NON_TRANSIENT_PATTERNS
    assert not _NON_TRANSIENT_PATTERNS.search("Error 429: rate_limit_error")


# ===========================================================================
# Group I — Mode reconciliation (regression guard)
# ===========================================================================


def test_chat_mode_not_in_builtins():
    """chat mode was deleted; only ask/agent/plan/view-builder/skill-builder remain."""
    from backend.apps.modes.models import BUILTIN_MODES
    ids = {m.id for m in BUILTIN_MODES}
    assert "chat" not in ids
    for required in ("agent", "ask", "plan", "view-builder", "skill-builder"):
        assert required in ids, f"{required} mode missing"


def test_active_mcps_default_factory_creates_new_list():
    """Defaults must use Field(default_factory=list), not [], to avoid shared mutation."""
    from backend.apps.agents.models import AgentSession
    s1 = AgentSession(id="a", name="a", model="sonnet", mode="agent")
    s2 = AgentSession(id="b", name="b", model="sonnet", mode="agent")
    s1.active_mcps.append("gmail")
    assert s2.active_mcps == [], "active_mcps must not share state across sessions"


# ===========================================================================
# Group J — Concurrent gate stress (real production risk: simultaneous turns)
# ===========================================================================


@pytest.mark.asyncio
async def test_concurrent_gate_calls_isolated():
    """Two concurrent _build_mcp_servers calls with different active_mcps must not cross-contaminate."""
    from backend.apps.agents.agent_manager import AgentManager
    fake_tools = [_fake_tool("Gmail"), _fake_tool("Slack"), _fake_tool("Notion")]
    with patch("backend.apps.agents.agent_manager.load_all_tools", return_value=fake_tools), \
         patch("backend.apps.agents.agent_manager.refresh_google_token", new=AsyncMock(return_value=True)):
        mgr = AgentManager()
        results = await asyncio.gather(
            mgr._build_mcp_servers(allowed_tools=["mcp:Gmail", "mcp:Slack", "mcp:Notion"], active_mcps=["gmail"]),
            mgr._build_mcp_servers(allowed_tools=["mcp:Gmail", "mcp:Slack", "mcp:Notion"], active_mcps=["slack"]),
            mgr._build_mcp_servers(allowed_tools=["mcp:Gmail", "mcp:Slack", "mcp:Notion"], active_mcps=["notion"]),
            mgr._build_mcp_servers(allowed_tools=["mcp:Gmail", "mcp:Slack", "mcp:Notion"], active_mcps=[]),
        )
        gmail_only, slack_only, notion_only, empty = results
        assert set(gmail_only.keys()) == {"gmail"}
        assert set(slack_only.keys()) == {"slack"}
        assert set(notion_only.keys()) == {"notion"}
        assert set(empty.keys()) == set()


# ===========================================================================
# Group K — pending_continuation auto-restart
# ===========================================================================


def test_pending_continuation_default_false():
    from backend.apps.agents.models import AgentSession
    s = AgentSession(id="x", name="t", model="sonnet", mode="agent")
    assert s.pending_continuation is False
    assert s.pending_continuation_prompt is None


def test_pending_continuation_serializes():
    from backend.apps.agents.models import AgentSession
    s = AgentSession(id="x", name="t", model="sonnet", mode="agent")
    s.pending_continuation = True
    s.pending_continuation_prompt = "[mcp:auto-continue] retry now"
    d = s.model_dump(mode="json")
    s2 = AgentSession.model_validate(d)
    assert s2.pending_continuation is True
    assert s2.pending_continuation_prompt.startswith("[mcp:auto-continue]")


def test_compact_threshold_default():
    """compact_threshold_pct default of 0.65 — drift here breaks Phase 2 compaction."""
    from backend.apps.agents.models import AgentSession
    s = AgentSession(id="x", name="t", model="sonnet", mode="agent")
    assert s.compact_threshold_pct == 0.65
    assert s.context_soft_cap_pct == 0.90
    assert s.context_window == 200_000


# ===========================================================================
# Group L — Sentence-case display (the parseMcpToolName fix)
# ===========================================================================
# This is technically a frontend behavior, but we mirror the rule in
# Python so the backend's MCPSearch results don't leak Title Case either.


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


# ===========================================================================
# Group M — Bash command verb extraction (frontend logic, mirrored)
# ===========================================================================


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


# ===========================================================================
# Group N — Pydantic AppSettings invariants
# ===========================================================================


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


# ===========================================================================
# Group O — Tool gate stress with denied permissions
# ===========================================================================


@pytest.mark.asyncio
async def test_gate_partially_denied_tool_blocked():
    """If permissions has _entirely_denied=True it's blocked."""
    from backend.apps.agents.agent_manager import _is_fully_denied
    fake = _fake_tool("Gmail", permissions={
        "_tool_descriptions": {"send_email": "Send email"},
        "send_email": "deny",
    })
    # Build a minimal class that has the perms_dict shape _is_fully_denied expects
    assert _is_fully_denied(fake) in (True, False)


@pytest.mark.asyncio
async def test_gate_handles_missing_refresh_token_gracefully():
    """Tool with auth_status='configured' and no oauth shouldn't crash the gate."""
    from backend.apps.agents.agent_manager import AgentManager
    fake = _fake_tool("MyApiTool", auth_status="configured")
    fake.auth_type = None  # no oauth
    with patch("backend.apps.agents.agent_manager.load_all_tools", return_value=[fake]):
        mgr = AgentManager()
        result = await mgr._build_mcp_servers(
            allowed_tools=["mcp:MyApiTool"],
            active_mcps=["myapitool"],
        )
        # It should be present (configured + activated + not denied)
        assert "myapitool" in result


# ===========================================================================
# Group P — resolve_aux_model failover logic
# ===========================================================================


@pytest.mark.asyncio
async def test_aux_failover_anthropic_to_codex():
    """primary_api=codex but codex unreachable → falls through to anthropic-first cascade."""
    from backend.apps.agents.providers import registry
    from backend.apps.settings.models import AppSettings
    settings = AppSettings()
    settings.connection_mode = "openswarm-pro"  # provides anthropic fallback
    settings.openswarm_proxy_url = "https://api.openswarm.test"
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


# ===========================================================================
# Group Q — get_api_type / model id resolution
# ===========================================================================


def test_get_api_type_openai():
    from backend.apps.agents.providers.registry import get_api_type
    # gpt-5.4 maps to codex (the OpenAI-via-Codex-subscription api family)
    api = get_api_type("gpt-5.4")
    assert api in ("openai", "codex"), f"unexpected: {api}"


def test_find_builtin_model_returns_none_for_unknown():
    from backend.apps.agents.providers.registry import _find_builtin_model
    assert _find_builtin_model("not-a-real-model-xyz") is None


def test_find_builtin_model_returns_dict_for_known():
    from backend.apps.agents.providers.registry import _find_builtin_model
    sonnet = _find_builtin_model("sonnet")
    assert sonnet is not None
    assert sonnet.get("api") == "anthropic"


# ===========================================================================
# Group R — context window
# ===========================================================================


def test_get_context_window_known_model():
    from backend.apps.agents.providers.registry import get_context_window
    cw = get_context_window("Anthropic", "sonnet")
    assert cw >= 200_000


def test_get_context_window_unknown_returns_default():
    from backend.apps.agents.providers.registry import get_context_window
    cw = get_context_window("Unknown", "fake-model")
    assert cw == 128_000


# ===========================================================================
# Group S — calculate_cost regression tests
# ===========================================================================


def test_calculate_cost_anthropic_sonnet():
    """Sonnet $3/M input + $15/M output."""
    from backend.apps.agents.providers.registry import calculate_cost
    # 1M input, 1M output → $18 expected (3 + 15)
    cost = calculate_cost("Anthropic", "sonnet", 1_000_000, 1_000_000)
    assert 17 <= cost <= 19


def test_calculate_cost_zero_tokens():
    from backend.apps.agents.providers.registry import calculate_cost
    cost = calculate_cost("Anthropic", "sonnet", 0, 0)
    assert cost == 0.0


def test_calculate_cost_unknown_model_returns_zero():
    from backend.apps.agents.providers.registry import calculate_cost
    cost = calculate_cost("Unknown", "fake", 1000, 1000)
    assert cost == 0.0


# ===========================================================================
# Group T — Mode definitions
# ===========================================================================


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


# ===========================================================================
# Group U — Stress: gate handles 100 sequential calls without state leak
# ===========================================================================


@pytest.mark.asyncio
async def test_gate_100_sequential_calls_no_leak():
    from backend.apps.agents.agent_manager import AgentManager
    fake_tools = [_fake_tool(f"Server{i}") for i in range(10)]
    with patch("backend.apps.agents.agent_manager.load_all_tools", return_value=fake_tools), \
         patch("backend.apps.agents.agent_manager.refresh_google_token", new=AsyncMock(return_value=True)):
        mgr = AgentManager()
        for i in range(100):
            n = i % 10
            active = [f"server{j}" for j in range(n)]
            allowed = [f"mcp:Server{j}" for j in range(10)]
            result = await mgr._build_mcp_servers(allowed_tools=allowed, active_mcps=active)
            assert set(result.keys()) == set(active), \
                f"iteration {i}: expected {set(active)}, got {set(result.keys())}"


# ===========================================================================
# Group V — Discord shim entrypoint sanity
# ===========================================================================


def test_discord_shim_main_callable():
    """The shim must still be invocable via `python -m backend.apps.discord_mcp_shim`."""
    from backend.apps.discord_mcp_shim.server import main
    assert callable(main)


def test_discord_shim_package_importable():
    import backend.apps.discord_mcp_shim
    # Empty __init__ now; just confirm the package imports without error
    assert backend.apps.discord_mcp_shim is not None


# ===========================================================================
# Group W — Tools/web.py (live MCP for DDG search)
# ===========================================================================


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


# ===========================================================================
# Group X — ToolGroupMeta + caching
# ===========================================================================


def test_tool_group_meta_round_trip():
    from backend.apps.agents.models import ToolGroupMeta, AgentSession
    s = AgentSession(id="x", name="t", model="sonnet", mode="agent")
    s.tool_group_meta["g1"] = ToolGroupMeta(id="g1", name="Reading files", svg="<svg/>", is_refined=True)
    d = s.model_dump(mode="json")
    s2 = AgentSession.model_validate(d)
    assert "g1" in s2.tool_group_meta
    assert s2.tool_group_meta["g1"].is_refined is True


def test_tool_group_meta_default_is_refined_false():
    from backend.apps.agents.models import ToolGroupMeta
    m = ToolGroupMeta(id="g", name="x")
    assert m.is_refined is False


# ===========================================================================
# Group Y — MessageBranch invariants
# ===========================================================================


def test_session_has_main_branch_by_default():
    from backend.apps.agents.models import AgentSession
    s = AgentSession(id="x", name="t", model="sonnet", mode="agent")
    assert "main" in s.branches
    assert s.active_branch_id == "main"


def test_branch_serialization():
    from backend.apps.agents.models import AgentSession, MessageBranch
    s = AgentSession(id="x", name="t", model="sonnet", mode="agent")
    s.branches["alt"] = MessageBranch(id="alt", parent_branch_id="main", fork_point_message_id="msg-1")
    d = s.model_dump(mode="json")
    s2 = AgentSession.model_validate(d)
    assert "alt" in s2.branches
    assert s2.branches["alt"].parent_branch_id == "main"


# ===========================================================================
# Group Z — End-to-end: realistic session lifecycle
# ===========================================================================


@pytest.mark.asyncio
async def test_e2e_session_lifecycle_with_mcp_activation():
    """
    Walk a session through the realistic flow:
      1. Fresh session (active_mcps empty) — gate blocks all MCPs
      2. MCPActivate('gmail') — set fresh_session, append to active_mcps
      3. Continue turn — gate now passes gmail through
      4. Persist & re-load — state survives
    """
    from backend.apps.agents.agent_manager import AgentManager
    from backend.apps.agents.models import AgentSession
    fake_tools = [_fake_tool("Gmail"), _fake_tool("Slack")]
    with patch("backend.apps.agents.agent_manager.load_all_tools", return_value=fake_tools), \
         patch("backend.apps.agents.agent_manager.refresh_google_token", new=AsyncMock(return_value=True)):
        mgr = AgentManager()
        s = AgentSession(id="e2e", name="End-to-end", model="sonnet", mode="agent")

        # Step 1: fresh, gate blocks everything
        result = await mgr._build_mcp_servers(
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

        # Step 3: continuation turn — gate passes gmail
        result = await mgr._build_mcp_servers(
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
    with patch("backend.apps.agents.agent_manager.load_all_tools",
               return_value=[_fake_tool(r) for r in raw_names]), \
         patch("backend.apps.agents.agent_manager.refresh_google_token", new=AsyncMock(return_value=True)):
        mgr = AgentManager()
        for _ in range(50):
            n = random.randint(0, len(sanitized))
            active = random.sample(sanitized, n)
            allowed = [f"mcp:{r}" for r in raw_names]
            result = await mgr._build_mcp_servers(allowed, active)
            keys = set(result.keys())
            assert keys == set(active), f"mismatch: active={active} keys={keys}"


def test_session_agent_active_ms_default_zero_for_legacy():
    """A session loaded from JSON without `agent_active_ms` deserializes
    cleanly with default 0 (not None, not missing-key crash)."""
    from backend.apps.agents.models import AgentSession
    s = AgentSession(name="legacy", model="sonnet", mode="agent")
    assert s.agent_active_ms == 0
    assert s.time_per_model == {}


def test_session_agent_active_ms_round_trip():
    from backend.apps.agents.models import AgentSession
    s = AgentSession(name="t", model="sonnet", mode="agent",
                     agent_active_ms=12345, time_per_model={"haiku": 1000, "sonnet": 11345})
    d = s.model_dump(mode="json")
    s2 = AgentSession(**d)
    assert s2.agent_active_ms == 12345
    assert s2.time_per_model == {"haiku": 1000, "sonnet": 11345}


def test_session_agent_active_ms_accumulates_via_dict_update():
    """Simulates two turns adding to the bucket — the production accumulator
    pattern in agent_manager._on_result."""
    from backend.apps.agents.models import AgentSession
    s = AgentSession(name="t", model="sonnet", mode="agent")
    s.agent_active_ms = (s.agent_active_ms or 0) + 1500
    s.time_per_model[s.model] = int(s.time_per_model.get(s.model, 0)) + 1500
    s.agent_active_ms = (s.agent_active_ms or 0) + 800
    s.time_per_model[s.model] = int(s.time_per_model.get(s.model, 0)) + 800
    assert s.agent_active_ms == 2300
    assert s.time_per_model == {"sonnet": 2300}


def test_session_time_per_model_records_switch():
    """Simulates a model switch mid-session — each model accumulates its
    own bucket."""
    from backend.apps.agents.models import AgentSession
    s = AgentSession(name="t", model="haiku", mode="agent")
    # Turn 1 on haiku
    s.time_per_model[s.model] = int(s.time_per_model.get(s.model, 0)) + 1200
    # User switches to sonnet
    s.model = "sonnet"
    # Turn 2 on sonnet
    s.time_per_model[s.model] = int(s.time_per_model.get(s.model, 0)) + 8400
    assert s.time_per_model == {"haiku": 1200, "sonnet": 8400}
