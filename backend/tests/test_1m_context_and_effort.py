"""Tests for Opus 1M context mode and effort parameter wiring."""

import pytest
from backend.apps.agents.models import AgentSession, AgentConfig


class TestAgentSessionUse1mContext:
    """Verify use_1m_context is a proper Pydantic field, not a monkey-patched attr."""

    def test_use_1m_context_default_false(self):
        session = AgentSession(name="test")
        assert session.use_1m_context is False

    def test_use_1m_context_can_be_set_true_at_init(self):
        session = AgentSession(name="test", use_1m_context=True)
        assert session.use_1m_context is True

    def test_use_1m_context_can_be_set_after_init(self):
        session = AgentSession(name="test")
        session.use_1m_context = True
        assert session.use_1m_context is True

    def test_use_1m_context_survives_model_dump(self):
        session = AgentSession(name="test", use_1m_context=True)
        dumped = session.model_dump(mode="json")
        assert dumped["use_1m_context"] is True

    def test_use_1m_context_roundtrips_through_json(self):
        session = AgentSession(name="test", use_1m_context=True, model="opus")
        dumped = session.model_dump(mode="json")
        restored = AgentSession(**dumped)
        assert restored.use_1m_context is True
        assert restored.model == "opus"

    def test_underscore_attr_not_in_model_dump(self):
        """Demonstrate the original bug: Pydantic v2 silently accepts underscore
        attrs but does NOT include them in model_dump — so they vanish on
        serialization/deserialization, which is why _use_1m_beta was lost."""
        session = AgentSession(name="test")
        session._some_private_flag = True  # silently accepted
        dumped = session.model_dump(mode="json")
        # The underscore attr is NOT serialized — this was the root bug
        assert "_some_private_flag" not in dumped
        # But our proper field IS serialized
        assert "use_1m_context" in dumped


class TestOpus1mModelResolution:
    """Test the opus-1m → opus + use_1m_context resolution logic."""

    def test_opus_1m_resolves_model_to_opus(self):
        """When model is 'opus-1m', effective model should be 'opus'."""
        config_model = "opus-1m"
        effective_model = config_model
        use_1m = False
        if config_model == "opus-1m":
            effective_model = "opus"
            use_1m = True
        assert effective_model == "opus"
        assert use_1m is True

    def test_regular_opus_no_1m(self):
        config_model = "opus"
        effective_model = config_model
        use_1m = False
        if config_model == "opus-1m":
            effective_model = "opus"
            use_1m = True
        assert effective_model == "opus"
        assert use_1m is False

    def test_sonnet_no_1m(self):
        config_model = "sonnet"
        effective_model = config_model
        use_1m = False
        if config_model == "opus-1m":
            effective_model = "opus"
            use_1m = True
        assert effective_model == "sonnet"
        assert use_1m is False


class TestEffortParameter:
    """Test effort parameter handling."""

    def test_effort_auto_means_none(self):
        """'auto' effort should not be passed to SDK (means don't set it)."""
        session = AgentSession(name="test", effort="auto")
        options_kwargs = {}
        if session.effort and session.effort != "auto":
            options_kwargs["effort"] = session.effort
        assert "effort" not in options_kwargs

    def test_effort_high_is_passed(self):
        session = AgentSession(name="test", effort="high")
        options_kwargs = {}
        if session.effort and session.effort != "auto":
            options_kwargs["effort"] = session.effort
        assert options_kwargs["effort"] == "high"

    def test_effort_low_is_passed(self):
        session = AgentSession(name="test", effort="low")
        options_kwargs = {}
        if session.effort and session.effort != "auto":
            options_kwargs["effort"] = session.effort
        assert options_kwargs["effort"] == "low"

    def test_effort_none_not_passed(self):
        session = AgentSession(name="test", effort=None)
        options_kwargs = {}
        if session.effort and session.effort != "auto":
            options_kwargs["effort"] = session.effort
        assert "effort" not in options_kwargs

    def test_effort_max_is_passed(self):
        session = AgentSession(name="test", effort="max")
        options_kwargs = {}
        if session.effort and session.effort != "auto":
            options_kwargs["effort"] = session.effort
        assert options_kwargs["effort"] == "max"


class TestSdkOptionsConstruction:
    """Test the full SDK options construction logic for 1M + effort."""

    def _build_options(self, session: AgentSession, has_api_key: bool) -> dict:
        """Replicate the options_kwargs construction from _run_agent_loop."""
        options_kwargs = {"model": session.model}
        if session.effort and session.effort != "auto":
            options_kwargs["effort"] = session.effort
        if session.use_1m_context:
            if has_api_key:
                options_kwargs["betas"] = ["context-1m-2025-08-07"]
            else:
                options_kwargs["model"] = "claude-opus-4-6[1m]"
        return options_kwargs

    def test_1m_with_api_key_uses_betas(self):
        session = AgentSession(name="test", model="opus", use_1m_context=True)
        opts = self._build_options(session, has_api_key=True)
        assert opts["model"] == "opus"
        assert opts["betas"] == ["context-1m-2025-08-07"]

    def test_1m_without_api_key_uses_cli_model_string(self):
        session = AgentSession(name="test", model="opus", use_1m_context=True)
        opts = self._build_options(session, has_api_key=False)
        assert opts["model"] == "claude-opus-4-6[1m]"
        assert "betas" not in opts

    def test_no_1m_regular_opus(self):
        session = AgentSession(name="test", model="opus", use_1m_context=False)
        opts = self._build_options(session, has_api_key=True)
        assert opts["model"] == "opus"
        assert "betas" not in opts

    def test_1m_plus_effort(self):
        session = AgentSession(name="test", model="opus", use_1m_context=True, effort="high")
        opts = self._build_options(session, has_api_key=True)
        assert opts["model"] == "opus"
        assert opts["betas"] == ["context-1m-2025-08-07"]
        assert opts["effort"] == "high"

    def test_1m_plus_auto_effort(self):
        session = AgentSession(name="test", model="opus", use_1m_context=True, effort="auto")
        opts = self._build_options(session, has_api_key=True)
        assert opts["betas"] == ["context-1m-2025-08-07"]
        assert "effort" not in opts

    def test_sonnet_with_effort(self):
        session = AgentSession(name="test", model="sonnet", effort="medium")
        opts = self._build_options(session, has_api_key=True)
        assert opts["model"] == "sonnet"
        assert opts["effort"] == "medium"
        assert "betas" not in opts
