"""Multi-instance app runtimes: two dashboard cards of the same app must get fully
independent AppRuntime processes on independent ports. Pins the invariants the
frontend's per-instance attach relies on: instance-suffixed registry keys, no shared
refcount between instances, fresh (non-.env) ports + OPENSWARM_FORCE_* env for
secondaries, and per-instance terminal.log files."""

import os

import pytest

from backend.apps.outputs.runtime import AppRuntime, AppRuntimeManager, runtime_key


def test_runtime_key_primary_is_bare_workspace_id():
    assert runtime_key("ws1", 1) == "ws1"
    assert runtime_key("ws1", 2) == "ws1#2"


@pytest.mark.asyncio
async def test_attach_two_instances_creates_independent_runtimes(tmp_path, monkeypatch):
    # Neither instance should actually spawn a process; pin start() to a no-op.
    async def p_fake_start(self):
        return True
    monkeypatch.setattr(AppRuntime, "start", p_fake_start)
    mgr = AppRuntimeManager()
    ws = str(tmp_path)
    rt1 = await mgr.attach("ws1", ws, 1)
    rt2 = await mgr.attach("ws1", ws, 2)
    assert rt1 is not rt2
    assert rt1.instance == 1 and rt2.instance == 2
    assert mgr.get("ws1", 1) is rt1
    assert mgr.get("ws1", 2) is rt2
    # Detaching one instance must not tear down or refcount-touch the other. (The stub runtime has no live process, so detach reaps it rather than idling it.)
    await mgr.detach("ws1", 2)
    assert "ws1" in mgr.runtimes
    assert mgr.get("ws1", 2) is None
    assert mgr.get("ws1", 1) is rt1


@pytest.mark.asyncio
async def test_secondary_instance_uses_fresh_ports_and_force_env(tmp_path, monkeypatch):
    # A new-mode workspace with pinned .env ports; the secondary must NOT reuse or rewrite them.
    ws = tmp_path / "ws"
    ws.mkdir()
    (ws / "run.sh").write_text("#!/bin/bash\n")
    (ws / ".env").write_text("FRONTEND_PORT=45001\nBACKEND_PORT=45002\n")
    captured_env: dict = {}

    async def p_fake_exec(*cmd, **kwargs):
        captured_env.update(kwargs.get("env") or {})
        raise RuntimeError("stop before real spawn")
    monkeypatch.setattr("asyncio.create_subprocess_exec", p_fake_exec)
    rt = AppRuntime("ws1", str(ws), instance=2)
    ok = await rt.start()
    # The stubbed spawn raises, so start() reports failure and nulls the ports; the forced env captured at spawn time carries what the secondary would have used.
    assert ok is False
    forced_fp = int(captured_env["OPENSWARM_FORCE_FRONTEND_PORT"])
    forced_bp = int(captured_env["OPENSWARM_FORCE_BACKEND_PORT"])
    assert forced_fp != 45001
    assert forced_bp != 45002
    # .env untouched: the primary still owns its pinned ports.
    assert (ws / ".env").read_text() == "FRONTEND_PORT=45001\nBACKEND_PORT=45002\n"


def test_secondary_terminal_log_is_suffixed(tmp_path):
    os.makedirs(os.path.join(str(tmp_path), ".openswarm"))
    rt1 = AppRuntime("ws1", str(tmp_path), instance=1)
    rt2 = AppRuntime("ws1", str(tmp_path), instance=2)
    rt1.record_frontend_log("log", "hello from instance 1")
    rt2.record_frontend_log("log", "hello from instance 2")
    files = sorted(os.listdir(os.path.join(str(tmp_path), ".openswarm")))
    assert files == ["terminal-2.log", "terminal.log"]
