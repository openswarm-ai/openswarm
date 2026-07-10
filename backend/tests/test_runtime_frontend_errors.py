"""The app's webview console.error lines, captured so the agent's post-tool hook can show them
alongside vite/uvicorn build errors. A clean build still leaves runtime TypeErrors that only the
browser ever sees; before this the agent was blind to them."""

import pytest

from backend.apps.outputs.runtime import AppRuntime, AppRuntimeManager

P_TYPE_ERROR = "TypeError: cards.map is not a function"


def p_runtime(workspace_path: str) -> AppRuntime:
    return AppRuntime(workspace_id="ws1", workspace_path=workspace_path, instance=1)


def test_console_error_is_captured_and_drained_once(tmp_path):
    rt = p_runtime(str(tmp_path))
    rt.record_frontend_log("error", P_TYPE_ERROR)
    assert rt.drain_frontend_errors() == [P_TYPE_ERROR]
    assert rt.drain_frontend_errors() == []


def test_console_log_and_warn_are_not_captured(tmp_path):
    rt = p_runtime(str(tmp_path))
    rt.record_frontend_log("log", "mounted")
    rt.record_frontend_log("warn", "deprecated prop")
    assert rt.drain_frontend_errors() == []


def test_render_beacons_are_not_captured_as_console_errors(tmp_path):
    """app-error rides the same console.error channel but already drives render_state via the
    report-* endpoints; capturing it would duplicate render_error_text into the agent's note."""
    rt = p_runtime(str(tmp_path))
    rt.record_frontend_log("error", "[openswarm:app-error] Boom at App.tsx:12")
    assert rt.drain_frontend_errors() == []


def test_console_errors_do_not_leak_into_the_build_error_queue(tmp_path):
    """Separate queues: drain_errors() is the process stderr scrape, and its ERROR_PATTERNS
    filter never sees console lines."""
    rt = p_runtime(str(tmp_path))
    rt.record_frontend_log("error", P_TYPE_ERROR)
    assert rt.drain_errors() == []


@pytest.mark.asyncio
async def test_drain_frontend_errors_for_path_finds_the_owning_workspace(tmp_path, monkeypatch):
    async def p_fake_start(self):
        return True
    monkeypatch.setattr(AppRuntime, "start", p_fake_start)
    mgr = AppRuntimeManager()
    rt = await mgr.attach("ws1", str(tmp_path), 1)
    rt.record_frontend_log("error", P_TYPE_ERROR)
    written = str(tmp_path / "frontend" / "src" / "App.tsx")
    assert mgr.drain_frontend_errors_for_path(written) == [P_TYPE_ERROR]
    assert mgr.drain_frontend_errors_for_path("/somewhere/else/main.py") == []
