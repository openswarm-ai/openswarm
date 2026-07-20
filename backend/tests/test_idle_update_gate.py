"""API surface of the desktop idle-update gate: the /agents/activity lookahead
fields Electron polls before a silent install, and the /service/updater-event
breadcrumb it fires when one happens."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from pydantic import ValidationError


@pytest.mark.asyncio
async def test_activity_reports_active_and_next_run(monkeypatch):
    from backend.apps.agents import agents as agents_module
    monkeypatch.setattr(agents_module.agent_manager, "tasks", {})
    monkeypatch.setattr("backend.apps.workflows.scheduler.seconds_to_next_fire", lambda: 123.0)
    out = await agents_module.agent_activity()
    assert out == {"active": 0, "next_run_in_s": 123.0}


@pytest.mark.asyncio
async def test_activity_lookahead_fails_open(monkeypatch):
    from backend.apps.agents import agents as agents_module

    def boom():
        raise RuntimeError("lookahead broke")

    monkeypatch.setattr(agents_module.agent_manager, "tasks", {})
    monkeypatch.setattr("backend.apps.workflows.scheduler.seconds_to_next_fire", boom)
    out = await agents_module.agent_activity()
    assert out["next_run_in_s"] is None


@pytest.mark.asyncio
async def test_updater_event_writes_analytics_log(monkeypatch):
    from backend.apps.service import service as service_module
    from backend.apps.service.analytics import client as analytics_client_module
    logs = Mock()
    monkeypatch.setattr(analytics_client_module, "get_analytics_client", lambda: SimpleNamespace(logs=logs))
    body = service_module.UpdaterEventBody(kind="idle_install", staged_version="1.5.9")
    out = await service_module.post_updater_event(body)
    assert out == {"ok": True}
    kw = logs.write.call_args.kwargs
    assert kw["tag"] == "updater"
    assert kw["subtag"] == "idle_install"
    assert kw["data"]["staged_version"] == "1.5.9"


@pytest.mark.asyncio
async def test_updater_event_survives_missing_client(monkeypatch):
    from backend.apps.service import service as service_module
    from backend.apps.service.analytics import client as analytics_client_module
    monkeypatch.setattr(analytics_client_module, "get_analytics_client", lambda: None)
    out = await service_module.post_updater_event(service_module.UpdaterEventBody(kind="idle_install"))
    assert out == {"ok": True}


def test_updater_event_kind_is_constrained():
    from backend.apps.service.service import UpdaterEventBody
    with pytest.raises(ValidationError):
        UpdaterEventBody(kind="anything_else")
