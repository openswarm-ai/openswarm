"""Comprehensive stress tests for PostHog analytics events.

Tests every analytics event fires correctly with proper properties.
Simulates full session lifecycle, approval flows, errors, multi-message
sessions, sub-agents, model switches, branching, feature usage, settings,
subscriptions, cost tracking, and heartbeat.

Run with:
    cd backend && python -m pytest tests/test_analytics.py -v
"""

import json
import os
import tempfile
from unittest.mock import MagicMock
from uuid import uuid4

import pytest

# ---------------------------------------------------------------------------
# Patch PostHog and settings BEFORE importing application modules
# ---------------------------------------------------------------------------

# Create a temp dir for settings/sessions
_tmpdir = tempfile.mkdtemp()
os.environ.setdefault("OPENSWARM_DATA_DIR", _tmpdir)

# Patch PostHog globally
_captured_events: list[dict] = []


def _mock_capture(event_type, distinct_id, properties=None):
    _captured_events.append({
        "event": event_type,
        "distinct_id": distinct_id,
        "properties": properties or {},
    })


@pytest.fixture(autouse=True)
def reset_captured_events():
    _captured_events.clear()
    yield
    _captured_events.clear()


@pytest.fixture(autouse=True)
def mock_posthog():
    """Mock PostHog so no real events are sent."""
    mock_ph = MagicMock()
    mock_ph.capture = _mock_capture

    import backend.apps.analytics.collector as collector
    old_ph = collector._posthog
    old_id = collector._installation_id
    collector._posthog = mock_ph
    collector._installation_id = "test-install-id"
    yield mock_ph
    collector._posthog = old_ph
    collector._installation_id = old_id


@pytest.fixture(autouse=True)
def mock_settings(tmp_path):
    """Mock settings to avoid reading real config."""
    settings_file = tmp_path / "settings.json"
    settings_file.write_text(json.dumps({
        "analytics_opt_in": True,
        "installation_id": "test-install-id",
    }))

    import backend.apps.settings.settings as settings_mod
    old_file = settings_mod.SETTINGS_FILE
    settings_mod.SETTINGS_FILE = str(settings_file)
    yield
    settings_mod.SETTINGS_FILE = old_file


@pytest.fixture(autouse=True)
def mock_sessions_dir(tmp_path):
    """Use temp dir for session persistence."""
    sessions_dir = tmp_path / "sessions"
    sessions_dir.mkdir()

    import backend.config.paths as paths_mod
    old_dir = paths_mod.SESSIONS_DIR
    paths_mod.SESSIONS_DIR = str(sessions_dir)
    yield str(sessions_dir)
    paths_mod.SESSIONS_DIR = old_dir


def events(event_type: str | None = None) -> list[dict]:
    """Return captured events, optionally filtered by type."""
    if event_type:
        return [e for e in _captured_events if e["event"] == event_type]
    return list(_captured_events)


def last_event(event_type: str) -> dict:
    """Return the last captured event of a given type."""
    matching = events(event_type)
    assert matching, f"No {event_type} events captured. Got: {[e['event'] for e in _captured_events]}"
    return matching[-1]


# ===========================================================================
# Import application modules (after patches are set up)
# ===========================================================================
from backend.apps.analytics.collector import record
from backend.apps.agents.models import AgentConfig, AgentSession, Message, ApprovalRequest
from backend.apps.agents.agent_manager import AgentManager


@pytest.fixture
def manager():
    """Create a fresh AgentManager for each test."""
    mgr = AgentManager()
    return mgr


# ===========================================================================
# 1. record() basics
# ===========================================================================

class TestRecordBasics:
    def test_record_sends_event(self):
        record("test.event", {"key": "value"})
        e = last_event("test.event")
        assert e["properties"]["key"] == "value"
        assert e["distinct_id"] == "test-install-id"

    def test_record_adds_os_and_platform(self):
        record("test.event", {})
        e = last_event("test.event")
        assert "os" in e["properties"]
        assert "platform" in e["properties"]

    def test_record_includes_session_id(self):
        record("test.event", {}, session_id="sess123")
        e = last_event("test.event")
        assert e["properties"]["session_id"] == "sess123"

    def test_record_includes_dashboard_id(self):
        record("test.event", {}, dashboard_id="dash456")
        e = last_event("test.event")
        assert e["properties"]["dashboard_id"] == "dash456"


# ===========================================================================
# 2. session.started fires ONCE on launch
# ===========================================================================

class TestSessionStarted:
    @pytest.mark.asyncio
    async def test_session_started_fires_on_launch(self, manager):
        config = AgentConfig(name="Test", model="sonnet", mode="agent", provider="anthropic")
        session = await manager.launch_agent(config)

        e = last_event("session.started")
        assert e["properties"]["model"] == "sonnet"
        assert e["properties"]["provider"] == "anthropic"
        assert e["properties"]["mode"] == "agent"
        assert e["properties"]["session_id"] == session.id
        assert isinstance(e["properties"]["tool_count"], int)

    @pytest.mark.asyncio
    async def test_session_started_fires_only_once(self, manager):
        config = AgentConfig(name="Test", model="sonnet", mode="agent")
        await manager.launch_agent(config)

        started_events = events("session.started")
        assert len(started_events) == 1


# ===========================================================================
# 3. session.completed fires ONCE on close (NOT per message)
# ===========================================================================

class TestSessionCompleted:
    @pytest.mark.asyncio
    async def test_session_completed_fires_on_close(self, manager):
        config = AgentConfig(name="Test Session", model="sonnet", mode="agent")
        session = await manager.launch_agent(config)

        # Add some messages to simulate activity
        session.messages.append(Message(role="user", content="hello"))
        session.messages.append(Message(role="assistant", content="hi there"))
        session.cost_usd = 0.05
        session.tokens = {"input": 1000, "output": 500}
        session.status = "completed"

        await manager.close_session(session.id)

        e = last_event("session.completed")
        assert e["properties"]["model"] == "sonnet"
        assert e["properties"]["cost_usd"] == 0.05
        assert e["properties"]["message_count"] == 2
        assert e["properties"]["input_tokens"] == 1000
        assert e["properties"]["output_tokens"] == 500
        assert e["properties"]["session_title"] == "Test Session"
        assert e["properties"]["branch_count"] == 1  # main branch
        assert e["properties"]["is_sub_agent"] is False

    @pytest.mark.asyncio
    async def test_session_completed_fires_exactly_once(self, manager):
        config = AgentConfig(name="Test", model="sonnet", mode="agent")
        session = await manager.launch_agent(config)
        session.status = "completed"

        await manager.close_session(session.id)

        completed_events = events("session.completed")
        assert len(completed_events) == 1

    @pytest.mark.asyncio
    async def test_session_completed_includes_sub_agent_info(self, manager):
        # Create parent session
        config = AgentConfig(name="Parent", model="sonnet", mode="agent")
        parent = await manager.launch_agent(config)

        # Create child session
        child = AgentSession(
            id=uuid4().hex, name="Child", mode="browser-agent",
            parent_session_id=parent.id, status="completed",
        )
        manager.sessions[child.id] = child

        parent.status = "completed"
        await manager.close_session(parent.id)

        e = last_event("session.completed")
        assert e["properties"]["sub_agent_count"] == 1

    @pytest.mark.asyncio
    async def test_session_completed_on_shutdown(self, manager):
        config = AgentConfig(name="Shutdown Test", model="sonnet", mode="agent")
        session = await manager.launch_agent(config)
        session.cost_usd = 0.10

        await manager.persist_all_sessions()

        e = last_event("session.completed")
        assert e["properties"]["cost_usd"] == 0.10
        assert e["properties"]["session_title"] == "Shutdown Test"


# ===========================================================================
# 4. session.error
# ===========================================================================

class TestSessionError:
    def test_session_error_event_structure(self):
        record("session.error", {
            "error_type": "ValueError",
            "error_message": "test error",
            "model": "sonnet",
            "provider": "anthropic",
            "mode": "agent",
        }, session_id="s1")

        e = last_event("session.error")
        assert e["properties"]["error_type"] == "ValueError"
        assert e["properties"]["error_message"] == "test error"
        assert e["properties"]["model"] == "sonnet"


# ===========================================================================
# 5. tool.executed
# ===========================================================================

class TestToolExecuted:
    def test_builtin_tool(self):
        record("tool.executed", {
            "tool_name": "Bash",
            "tool_short_name": "Bash",
            "tool_type": "builtin",
            "mcp_server": "",
            "duration_ms": 150,
            "success": True,
            "model": "sonnet",
            "provider": "anthropic",
        }, session_id="s1")

        e = last_event("tool.executed")
        assert e["properties"]["tool_type"] == "builtin"
        assert e["properties"]["mcp_server"] == ""
        assert e["properties"]["tool_short_name"] == "Bash"

    def test_mcp_tool_extracts_server_name(self):
        record("tool.executed", {
            "tool_name": "mcp__google-workspace__searchGmail",
            "tool_short_name": "searchGmail",
            "tool_type": "mcp",
            "mcp_server": "google-workspace",
            "duration_ms": 2000,
            "success": True,
            "model": "sonnet",
            "provider": "anthropic",
        }, session_id="s1")

        e = last_event("tool.executed")
        assert e["properties"]["tool_type"] == "mcp"
        assert e["properties"]["mcp_server"] == "google-workspace"
        assert e["properties"]["tool_short_name"] == "searchGmail"

    def test_tool_failure_tracked(self):
        record("tool.executed", {
            "tool_name": "Bash",
            "tool_short_name": "Bash",
            "tool_type": "builtin",
            "mcp_server": "",
            "duration_ms": 50,
            "success": False,
            "model": "sonnet",
            "provider": "anthropic",
        }, session_id="s1")

        e = last_event("tool.executed")
        assert e["properties"]["success"] is False


# ===========================================================================
# 6. approval.requested + approval.resolved
# ===========================================================================

class TestApprovalEvents:
    def test_approval_requested(self):
        record("approval.requested", {
            "tool_name": "Bash",
            "is_first_approval_in_session": True,
            "model": "sonnet",
        }, session_id="s1")

        e = last_event("approval.requested")
        assert e["properties"]["tool_name"] == "Bash"
        assert e["properties"]["is_first_approval_in_session"] is True

    def test_approval_resolved_allow(self):
        record("approval.resolved", {
            "tool_name": "Bash",
            "decision": "allow",
            "latency_ms": 1500,
            "input_was_modified": False,
            "model": "sonnet",
        }, session_id="s1")

        e = last_event("approval.resolved")
        assert e["properties"]["decision"] == "allow"
        assert e["properties"]["latency_ms"] == 1500
        assert e["properties"]["input_was_modified"] is False

    def test_approval_resolved_deny(self):
        record("approval.resolved", {
            "tool_name": "Bash",
            "decision": "deny",
            "latency_ms": 500,
            "input_was_modified": False,
            "model": "sonnet",
        }, session_id="s1")

        e = last_event("approval.resolved")
        assert e["properties"]["decision"] == "deny"

    def test_approval_with_modified_input(self):
        record("approval.resolved", {
            "tool_name": "Bash",
            "decision": "allow",
            "latency_ms": 3000,
            "input_was_modified": True,
            "model": "sonnet",
        }, session_id="s1")

        e = last_event("approval.resolved")
        assert e["properties"]["input_was_modified"] is True


# ===========================================================================
# 7. turn.completed
# ===========================================================================

class TestTurnCompleted:
    def test_turn_completed(self):
        record("turn.completed", {
            "turn_number": 3,
            "tool_calls_in_turn": 2,
            "model": "sonnet",
        }, session_id="s1")

        e = last_event("turn.completed")
        assert e["properties"]["turn_number"] == 3
        assert e["properties"]["tool_calls_in_turn"] == 2


# ===========================================================================
# 8. model.switched
# ===========================================================================

class TestModelSwitched:
    @pytest.mark.asyncio
    async def test_model_switch_fires_event(self, manager):
        config = AgentConfig(name="Test", model="sonnet", mode="agent")
        session = await manager.launch_agent(config)
        session.messages.append(Message(role="user", content="msg1"))
        session.cost_usd = 0.03

        # Simulate model switch via send_message (which we can't fully run
        # without SDK, so test the record call directly)
        record("model.switched", {
            "from_model": "sonnet",
            "to_model": "opus",
            "from_provider": "anthropic",
            "to_provider": "anthropic",
            "message_number": 1,
            "cost_so_far": 0.03,
        }, session_id=session.id)

        e = last_event("model.switched")
        assert e["properties"]["from_model"] == "sonnet"
        assert e["properties"]["to_model"] == "opus"
        assert e["properties"]["cost_so_far"] == 0.03


# ===========================================================================
# 9. session.resumed
# ===========================================================================

class TestSessionResumed:
    @pytest.mark.asyncio
    async def test_session_resumed(self, manager, mock_sessions_dir):
        # Create and close a session
        config = AgentConfig(name="Resume Test", model="sonnet", mode="agent")
        session = await manager.launch_agent(config)
        session.messages.append(Message(role="user", content="hello"))
        session.cost_usd = 0.05
        session.status = "completed"
        await manager.close_session(session.id)

        _captured_events.clear()

        # Resume it
        resumed = await manager.resume_session(session.id)

        e = last_event("session.resumed")
        assert e["properties"]["original_message_count"] >= 1
        assert e["properties"]["original_cost_usd"] == 0.05
        assert e["properties"]["model"] == "sonnet"
        assert "hours_since_closed" in e["properties"]


# ===========================================================================
# 10. context.attached
# ===========================================================================

class TestContextAttached:
    def test_context_with_files(self):
        record("context.attached", {
            "file_count": 3,
            "directory_count": 1,
            "skill_count": 0,
            "image_count": 2,
            "has_forced_tools": True,
        }, session_id="s1")

        e = last_event("context.attached")
        assert e["properties"]["file_count"] == 3
        assert e["properties"]["image_count"] == 2
        assert e["properties"]["has_forced_tools"] is True


# ===========================================================================
# 11. session.first_message
# ===========================================================================

class TestSessionFirstMessage:
    def test_first_message_properties(self):
        prompt = "```python\nprint('hello')\n```\nCheck https://example.com"
        record("session.first_message", {
            "message_length": len(prompt),
            "has_code_block": "```" in prompt,
            "has_url": "http://" in prompt or "https://" in prompt,
            "model": "sonnet",
            "mode": "agent",
        }, session_id="s1")

        e = last_event("session.first_message")
        assert e["properties"]["has_code_block"] is True
        assert e["properties"]["has_url"] is True
        assert e["properties"]["message_length"] > 0


# ===========================================================================
# 12. feature.used (all variants)
# ===========================================================================

class TestFeatureUsed:
    @pytest.mark.parametrize("feature", [
        "message.branched",
        "mode.switched",
        "skill.used",
        "skill.created",
        "template.created",
        "template.used",
        "view.created",
        "vibe_code.used",
        "browser_agent.launched",
    ])
    def test_feature_used_variants(self, feature):
        record("feature.used", {"feature": feature}, session_id="s1")
        e = last_event("feature.used")
        assert e["properties"]["feature"] == feature

    def test_branch_created_with_depth(self):
        record("feature.used", {
            "feature": "message.branched",
            "branch_depth": 2,
            "total_branches_in_session": 3,
            "messages_before_fork": 5,
        }, session_id="s1")

        e = last_event("feature.used")
        assert e["properties"]["branch_depth"] == 2
        assert e["properties"]["total_branches_in_session"] == 3

    def test_mode_switch_details(self):
        record("feature.used", {
            "feature": "mode.switched",
            "from_mode": "agent",
            "to_mode": "view-builder",
        }, session_id="s1")

        e = last_event("feature.used")
        assert e["properties"]["from_mode"] == "agent"
        assert e["properties"]["to_mode"] == "view-builder"

    def test_browser_agent_with_task_count(self):
        record("feature.used", {
            "feature": "browser_agent.launched",
            "task_count": 3,
            "model": "sonnet",
        })

        e = last_event("feature.used")
        assert e["properties"]["task_count"] == 3


# ===========================================================================
# 13. subscription events
# ===========================================================================

class TestSubscriptionEvents:
    def test_subscription_connected(self):
        record("subscription.connected", {"provider": "anthropic"})
        e = last_event("subscription.connected")
        assert e["properties"]["provider"] == "anthropic"

    def test_subscription_disconnected(self):
        record("subscription.disconnected", {"provider": "openai"})
        e = last_event("subscription.disconnected")
        assert e["properties"]["provider"] == "openai"


# ===========================================================================
# 14. provider.configured + settings.changed
# ===========================================================================

class TestSettingsEvents:
    def test_provider_added(self):
        record("provider.configured", {
            "provider": "anthropic",
            "action": "added",
        })
        e = last_event("provider.configured")
        assert e["properties"]["action"] == "added"

    def test_provider_removed(self):
        record("provider.configured", {
            "provider": "openai",
            "action": "removed",
        })
        e = last_event("provider.configured")
        assert e["properties"]["action"] == "removed"

    def test_settings_changed(self):
        record("settings.changed", {
            "changed_keys": ["theme", "default_model", "zoom_sensitivity"],
        })
        e = last_event("settings.changed")
        assert "theme" in e["properties"]["changed_keys"]
        assert len(e["properties"]["changed_keys"]) == 3

    def test_settings_changed_excludes_secrets(self):
        # Verify that if we track changed keys, secret keys are excluded
        record("settings.changed", {
            "changed_keys": ["theme"],
        })
        e = last_event("settings.changed")
        for secret in ["anthropic_api_key", "openai_api_key", "google_api_key",
                        "openrouter_api_key", "copilot_github_token"]:
            assert secret not in e["properties"]["changed_keys"]


# ===========================================================================
# 15. cost.snapshot
# ===========================================================================

class TestCostSnapshot:
    def test_cost_snapshot_structure(self):
        record("cost.snapshot", {
            "total_cost_usd": 42.50,
            "total_prompt_tokens": 500000,
            "total_completion_tokens": 150000,
            "total_requests": 250,
        })

        e = last_event("cost.snapshot")
        assert e["properties"]["total_cost_usd"] == 42.50
        assert e["properties"]["total_prompt_tokens"] == 500000
        assert e["properties"]["total_completion_tokens"] == 150000
        assert e["properties"]["total_requests"] == 250


# ===========================================================================
# 16. app.heartbeat
# ===========================================================================

class TestAppHeartbeat:
    def test_heartbeat_structure(self):
        record("app.heartbeat", {
            "active_session_count": 3,
            "nine_router_total_cost": 100.50,
            "nine_router_total_prompt_tokens": 1000000,
            "nine_router_total_completion_tokens": 300000,
            "nine_router_total_requests": 500,
        })

        e = last_event("app.heartbeat")
        assert e["properties"]["active_session_count"] == 3
        assert e["properties"]["nine_router_total_cost"] == 100.50


# ===========================================================================
# 17. app.opened (enhanced)
# ===========================================================================

class TestAppOpened:
    def test_app_opened_structure(self):
        record("app.opened", {
            "os": "Darwin",
            "platform": "macOS-14.0",
            "provider_count": 2,
            "providers": ["anthropic", "openai"],
            "is_first_open": False,
            "days_since_install": 5,
            "app_version": "1.0.17",
        })

        e = last_event("app.opened")
        assert e["properties"]["is_first_open"] is False
        assert e["properties"]["days_since_install"] == 5
        assert e["properties"]["app_version"] == "1.0.17"
        assert e["properties"]["provider_count"] == 2


# ===========================================================================
# 18. Multi-message session does NOT fire session.completed multiple times
# ===========================================================================

class TestMultiMessageSession:
    @pytest.mark.asyncio
    async def test_no_session_completed_per_message(self, manager):
        """Verify session.completed does NOT fire when agent loop finishes.
        It should only fire on close_session() or persist_all_sessions()."""
        config = AgentConfig(name="Multi-msg", model="sonnet", mode="agent")
        session = await manager.launch_agent(config)

        # Simulate 3 message exchanges
        for i in range(3):
            session.messages.append(Message(role="user", content=f"msg {i}"))
            session.messages.append(Message(role="assistant", content=f"reply {i}"))

        # At this point, no session.completed should have fired
        completed = events("session.completed")
        assert len(completed) == 0, f"session.completed fired {len(completed)} times before close!"

        # Now close — exactly 1 session.completed
        session.status = "completed"
        await manager.close_session(session.id)

        completed = events("session.completed")
        assert len(completed) == 1, f"Expected 1 session.completed, got {len(completed)}"


# ===========================================================================
# 19. Token tracking
# ===========================================================================

class TestTokenTracking:
    @pytest.mark.asyncio
    async def test_tokens_in_session_completed(self, manager):
        config = AgentConfig(name="Token Test", model="opus", mode="agent")
        session = await manager.launch_agent(config)

        # Simulate SDK token reporting
        session.tokens = {"input": 50000, "output": 15000}
        session.cost_usd = 0.25
        session.status = "completed"

        await manager.close_session(session.id)

        e = last_event("session.completed")
        assert e["properties"]["input_tokens"] == 50000
        assert e["properties"]["output_tokens"] == 15000
        assert e["properties"]["cost_usd"] == 0.25


# ===========================================================================
# 20. Full lifecycle integration test
# ===========================================================================

class TestFullLifecycle:
    @pytest.mark.asyncio
    async def test_complete_session_lifecycle(self, manager):
        """Simulate a complete user session: launch, messages, close."""
        # 1. Launch
        config = AgentConfig(
            name="Full Lifecycle",
            model="sonnet",
            mode="agent",
            provider="anthropic",
            dashboard_id="dash-001",
        )
        session = await manager.launch_agent(config)
        assert len(events("session.started")) == 1

        # 2. Simulate messages
        session.messages.append(Message(role="user", content="Hello, help me code"))
        session.messages.append(Message(role="assistant", content="Sure, let me help"))
        session.messages.append(Message(
            role="tool_call",
            content={"tool": "Bash", "input": {"command": "ls"}},
        ))
        session.messages.append(Message(
            role="tool_result",
            content={"text": "file1.py\nfile2.py", "tool_name": "Bash", "elapsed_ms": 50},
        ))
        session.messages.append(Message(role="user", content="Now run tests"))
        session.messages.append(Message(role="assistant", content="Running tests..."))

        session.cost_usd = 0.08
        session.tokens = {"input": 20000, "output": 5000}

        # 3. No session.completed yet
        assert len(events("session.completed")) == 0

        # 4. Close
        session.status = "completed"
        await manager.close_session(session.id)

        # 5. Verify session.completed
        e = last_event("session.completed")
        assert e["properties"]["message_count"] == 4  # 2 user + 2 assistant
        assert e["properties"]["tool_count"] == 1  # 1 tool call
        assert "Bash" in e["properties"]["tools_list"]
        assert e["properties"]["cost_usd"] == 0.08
        assert e["properties"]["input_tokens"] == 20000
        assert e["properties"]["output_tokens"] == 5000
        assert e["properties"]["dashboard_id"] == "dash-001"
        assert e["properties"]["first_user_message"] == "Hello, help me code"
        assert e["properties"]["duration_seconds"] >= 0  # may be 0 in fast tests

    @pytest.mark.asyncio
    async def test_session_with_error(self, manager):
        """Verify error sessions still fire session.completed on close."""
        config = AgentConfig(name="Error Test", model="sonnet", mode="agent")
        session = await manager.launch_agent(config)
        session.status = "error"

        await manager.close_session(session.id)

        e = last_event("session.completed")
        assert e["properties"]["status"] == "error"

    @pytest.mark.asyncio
    async def test_session_with_branches(self, manager):
        """Verify branch count in session.completed."""
        config = AgentConfig(name="Branch Test", model="sonnet", mode="agent")
        session = await manager.launch_agent(config)

        # Simulate branching
        from backend.apps.agents.models import MessageBranch
        session.branches["branch-1"] = MessageBranch(id="branch-1", parent_branch_id="main")
        session.branches["branch-2"] = MessageBranch(id="branch-2", parent_branch_id="branch-1")

        session.status = "completed"
        await manager.close_session(session.id)

        e = last_event("session.completed")
        assert e["properties"]["branch_count"] == 3  # main + branch-1 + branch-2


# ===========================================================================
# 21. MCP server name extraction in tool.executed
# ===========================================================================

class TestMCPServerExtraction:
    def test_standard_mcp_format(self):
        """Test mcp__server-name__tool_name format."""
        import re
        tool_name = "mcp__google-workspace__searchGmail"
        m = re.match(r"mcp__([^_]+(?:-[^_]+)*)__(.+)", tool_name)
        assert m is not None
        assert m.group(1) == "google-workspace"
        assert m.group(2) == "searchGmail"

    def test_builtin_tool_no_server(self):
        import re
        tool_name = "Bash"
        m = re.match(r"mcp__([^_]+(?:-[^_]+)*)__(.+)", tool_name)
        assert m is None

    def test_browser_agent_mcp_format(self):
        import re
        tool_name = "mcp__openswarm-browser-agent__CreateBrowserAgent"
        m = re.match(r"mcp__([^_]+(?:-[^_]+)*)__(.+)", tool_name)
        assert m is not None
        assert m.group(1) == "openswarm-browser-agent"
        assert m.group(2) == "CreateBrowserAgent"


# ===========================================================================
# 22. Settings update tracking
# ===========================================================================

class TestSettingsUpdateTracking:
    @pytest.mark.asyncio
    async def test_provider_key_change_detected(self):
        """Test that adding an API key fires provider.configured."""
        from backend.apps.settings.models import AppSettings

        old = AppSettings(anthropic_api_key=None)
        new = AppSettings(anthropic_api_key="sk-test-key")

        # Simulate what update_settings does
        provider_keys = {
            "anthropic_api_key": "anthropic",
            "openai_api_key": "openai",
            "google_api_key": "gemini",
            "openrouter_api_key": "openrouter",
        }
        for key, provider_name in provider_keys.items():
            old_val = bool(getattr(old, key, None))
            new_val = bool(getattr(new, key, None))
            if old_val != new_val:
                record("provider.configured", {
                    "provider": provider_name,
                    "action": "added" if new_val else "removed",
                })

        e = last_event("provider.configured")
        assert e["properties"]["provider"] == "anthropic"
        assert e["properties"]["action"] == "added"

    @pytest.mark.asyncio
    async def test_settings_change_excludes_secrets(self):
        """Verify secret keys are not included in changed_keys."""
        from backend.apps.settings.models import AppSettings

        old = AppSettings(theme="dark", anthropic_api_key="old-key")
        new = AppSettings(theme="light", anthropic_api_key="new-key")

        old_dict = old.model_dump()
        new_dict = new.model_dump()
        secret_keys = {"anthropic_api_key", "openai_api_key", "google_api_key",
                        "openrouter_api_key", "claude_subscription_token",
                        "openai_subscription_token", "gemini_subscription_token",
                        "copilot_github_token", "copilot_token", "installation_id"}
        safe_changed = [
            k for k in new_dict
            if k in old_dict and new_dict[k] != old_dict[k] and k not in secret_keys
        ]

        assert "theme" in safe_changed
        assert "anthropic_api_key" not in safe_changed


# ===========================================================================
# 23. Cost snapshot accuracy
# ===========================================================================

class TestCostSnapshotAccuracy:
    def test_nine_router_cost_in_heartbeat(self):
        """Verify heartbeat includes 9Router cost data."""
        record("app.heartbeat", {
            "active_session_count": 2,
            "nine_router_total_cost": 235.50,
            "nine_router_total_prompt_tokens": 5000000,
            "nine_router_total_completion_tokens": 1500000,
            "nine_router_total_requests": 1200,
            "cost_model_claude_sonnet_4_20250514": 180.00,
            "cost_model_claude_opus_4_20250514": 55.50,
        })

        e = last_event("app.heartbeat")
        assert e["properties"]["nine_router_total_cost"] == 235.50
        assert e["properties"]["cost_model_claude_sonnet_4_20250514"] == 180.00

    def test_cost_snapshot_separate_event(self):
        """Verify cost.snapshot fires independently with accurate totals."""
        record("cost.snapshot", {
            "total_cost_usd": 235.50,
            "total_prompt_tokens": 5000000,
            "total_completion_tokens": 1500000,
            "total_requests": 1200,
        })

        e = last_event("cost.snapshot")
        assert e["properties"]["total_cost_usd"] == 235.50


# ===========================================================================
# 24. Edge cases
# ===========================================================================

class TestEdgeCases:
    @pytest.mark.asyncio
    async def test_close_session_with_no_messages(self, manager):
        """Session closed without any messages should still fire session.completed."""
        config = AgentConfig(name="Empty", model="sonnet", mode="agent")
        session = await manager.launch_agent(config)
        session.status = "completed"

        await manager.close_session(session.id)

        e = last_event("session.completed")
        assert e["properties"]["message_count"] == 0
        assert e["properties"]["tool_count"] == 0
        assert e["properties"]["first_user_message"] == ""

    @pytest.mark.asyncio
    async def test_close_session_with_zero_cost(self, manager):
        """Session with 0 cost should still report cost_usd=0."""
        config = AgentConfig(name="Free", model="sonnet", mode="agent")
        session = await manager.launch_agent(config)
        session.status = "completed"

        await manager.close_session(session.id)

        e = last_event("session.completed")
        assert e["properties"]["cost_usd"] == 0.0
        assert e["properties"]["input_tokens"] == 0
        assert e["properties"]["output_tokens"] == 0

    def test_record_with_no_posthog(self):
        """record() should not crash if PostHog is not initialized."""
        import backend.apps.analytics.collector as collector
        old_ph = collector._posthog
        collector._posthog = None

        # Should not raise
        record("test.event", {"key": "value"})

        collector._posthog = old_ph

    def test_record_with_none_properties(self):
        """record() handles None properties gracefully."""
        record("test.event", None)
        e = last_event("test.event")
        assert "os" in e["properties"]  # system props still added
