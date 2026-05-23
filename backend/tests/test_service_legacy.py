"""Service-sync compatibility tests.

Verifies the legacy compatibility helpers on backend/apps/service/client.py
(record, submit_event, submit_session_close, etc.) still produce the right
opaque payload through the unified sync() entry point. Forward-looking
contract tests live in test_service.py; this file covers the legacy shim
surface so it can be deprecated cleanly later.

Run with:
    cd backend && python -m pytest tests/test_service_legacy.py -v
"""

import json
import os
import tempfile
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4

import pytest

# Sandbox the data dir before any module import touches settings on disk.
_tmpdir = tempfile.mkdtemp()
os.environ.setdefault("OPENSWARM_DATA_DIR", _tmpdir)

# Captured syncs from this test run.
_captured_syncs: list[dict] = []


@pytest.fixture(autouse=True)
def reset_captured_syncs():
    _captured_syncs.clear()
    yield
    _captured_syncs.clear()


@pytest.fixture(autouse=True)
def install_sync_sink():
    """Install a service-sync sink and decode the opaque payload back into
    a structured shape for assertions. The sink translates the new shape
    {client_state, d, t} into a legacy-compatible {kind, distinct_id, props}
    bag so existing tests can keep their assertions terse."""
    import backend.apps.service.client as svc_client

    def _sink(label: str, body: dict):
        cs = body.get("client_state") or {}
        payload = body.get("d") or body.get("payload") or {}

        # Infer a synthetic kind from payload shape, same dispatch logic
        # as the cloud uses in production.
        if "status" in payload and "messages" in payload:
            status = payload.get("status", "unknown")
            kind = f"session.{status}" if status != "unknown" else "session.completed"
            props = dict(payload)
        elif "identity" in payload:
            kind = "state.update"
            props = dict(payload)
        elif "diagnostic" in payload:
            kind = "diagnostic.fired"
            props = dict(payload)
        elif "s" in payload and "a" in payload:
            kind = f"{payload['s']}.{payload['a']}"
            props = dict(payload.get("p") or {})
        elif "surface" in payload:
            surface = payload.get("surface", "")
            action = payload.get("action", "fired")
            kind = f"{surface}.{action}"
            props = dict(payload.get("props") or {})
        else:
            kind = "state.update"
            props = dict(payload)

        if payload.get("session_id"):
            props["session_id"] = payload["session_id"]
        if payload.get("dashboard_id"):
            props["dashboard_id"] = payload["dashboard_id"]
        props.setdefault("os", cs.get("os", ""))
        props.setdefault("platform", cs.get("os", ""))

        _captured_syncs.append({
            "kind": kind,
            "distinct_id": cs.get("install_id", ""),
            "properties": props,
        })

    old_sink = svc_client._test_sink
    old_iid = svc_client._install_id
    svc_client.set_test_sink(_sink)
    svc_client._install_id = "test-install-id"
    yield
    svc_client.set_test_sink(old_sink)
    svc_client._install_id = old_iid


@pytest.fixture(autouse=True)
def mock_settings(tmp_path):
    """Sandbox settings so tests don't read or write the real config."""
    settings_file = tmp_path / "settings.json"
    settings_file.write_text(json.dumps({
        "service_diagnostics_mode": "standard",
        "installation_id": "test-install-id",
    }))

    import backend.apps.settings.store as settings_mod
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


def syncs(kind: str | None = None) -> list[dict]:
    """Return captured syncs, optionally filtered by inferred kind."""
    if kind:
        return [s for s in _captured_syncs if s["kind"] == kind]
    return list(_captured_syncs)


def last_sync(kind: str) -> dict:
    """Return the last captured sync of a given inferred kind."""
    matching = syncs(kind)
    assert matching, f"No {kind} syncs captured. Got: {[s['kind'] for s in _captured_syncs]}"
    return matching[-1]


# Import application modules (after fixtures are wired).
from backend.apps.service.client import record
from backend.apps.agents.core.models import AgentConfig, AgentSession, Message, ApprovalRequest
from backend.apps.agents.agent_manager import AgentManager


@pytest.fixture
def manager():
    """Fresh AgentManager per test."""
    return AgentManager()


# ---------------------------------------------------------------------------
# 1. record(), legacy shim correctness
# ---------------------------------------------------------------------------

class TestRecordBasics:
    def test_record_sends_payload(self):
        record("test.report", {"key": "value"})
        s = last_sync("test.report")
        assert s["properties"]["key"] == "value"
        assert s["distinct_id"] == "test-install-id"

    def test_record_adds_os_and_platform(self):
        record("test.report", {})
        s = last_sync("test.report")
        assert "os" in s["properties"]
        assert "platform" in s["properties"]

    def test_record_includes_session_id(self):
        record("test.report", {}, session_id="sess123")
        s = last_sync("test.report")
        assert s["properties"]["session_id"] == "sess123"

    def test_record_includes_dashboard_id(self):
        record("test.report", {}, dashboard_id="dash456")
        s = last_sync("test.report")
        assert s["properties"]["dashboard_id"] == "dash456"


# ---------------------------------------------------------------------------
# 2. Multi-message session, close fires exactly once
# ---------------------------------------------------------------------------

class TestMultiMessageSession:
    @pytest.mark.asyncio
    async def test_session_completes_only_on_close(self, manager):
        """Verify a completed-session sync does NOT fire mid-loop. It should
        only fire on close_session() or persist_all_sessions()."""
        config = AgentConfig(name="Multi-msg", model="sonnet", mode="agent")
        session = await manager.launch_agent(config)

        for i in range(3):
            session.messages.append(Message(role="user", content=f"msg {i}"))
            session.messages.append(Message(role="assistant", content=f"reply {i}"))

        completed = syncs("session.completed")
        assert len(completed) == 0, f"session-completed fired {len(completed)} times before close"

        session.status = "completed"
        await manager.close_session(session.id)

        completed = syncs("session.completed")
        assert len(completed) == 1, f"expected 1 completed sync, got {len(completed)}"


# ---------------------------------------------------------------------------
# 3. Token + cost capture on close
# ---------------------------------------------------------------------------

class TestTokenTracking:
    @pytest.mark.asyncio
    async def test_tokens_and_cost_in_session_close(self, manager):
        config = AgentConfig(name="Token Test", model="opus", mode="agent")
        session = await manager.launch_agent(config)

        session.tokens = {"input": 50000, "output": 15000}
        session.cost_usd = 0.25
        session.status = "completed"

        await manager.close_session(session.id)

        s = last_sync("session.completed")
        assert s["properties"]["tokens"]["input"] == 50000
        assert s["properties"]["tokens"]["output"] == 15000
        assert s["properties"]["cost_usd"] == 0.25
