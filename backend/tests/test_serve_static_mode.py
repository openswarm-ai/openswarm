"""ENG-209: an open app nobody is editing serves its built bundle with NO process; vite comes back
the moment an agent binds or the dist goes stale. Every transition is covered, since a wrong switch
would break preview for every app."""

import asyncio
import os
import time

from backend.apps.outputs import static_serve
from backend.apps.outputs.runtime import AppRuntime, AppRuntimeManager


def p_seed(tmp_path, relative_assets=True, with_dist=True):
    ws = tmp_path / "ws"
    fe = ws / "frontend"
    (fe / "src").mkdir(parents=True)
    (fe / "src" / "App.tsx").write_text("export {}")
    (fe / "package.json").write_text("{}")
    (ws / "run.sh").write_text("#!/bin/bash\n")
    if with_dist:
        dist = fe / "dist"
        dist.mkdir()
        src = "./assets/index-abc.js" if relative_assets else "/assets/index-abc.js"
        (dist / "index.html").write_text(f'<html><script src="{src}"></script></html>')
    return str(ws)


def test_static_fresh_requires_dist_newer_than_source_and_relative_assets(tmp_path):
    ws = p_seed(tmp_path)
    assert static_serve.static_fresh(ws) is True
    time.sleep(0.02)
    os.utime(os.path.join(ws, "frontend", "src", "App.tsx"))
    assert static_serve.static_fresh(ws) is False
    assert static_serve.static_fresh(p_seed(tmp_path / "abs", relative_assets=False)) is False
    assert static_serve.static_fresh(p_seed(tmp_path / "nodist", with_dist=False)) is False


def test_start_serves_static_when_not_edited(tmp_path, monkeypatch):
    ws = p_seed(tmp_path)
    monkeypatch.setattr(static_serve, "workspace_being_edited", lambda p: False)
    rt = AppRuntime("ws-t", ws)
    assert asyncio.run(rt.start()) is True
    assert rt.serve_static is True and rt.process is None and rt.ready is True
    assert "/serve/frontend/dist/index.html" in (rt.frontend_url or "")


def test_start_skips_serve_when_edited(tmp_path, monkeypatch):
    ws = p_seed(tmp_path)
    monkeypatch.setattr(static_serve, "workspace_being_edited", lambda p: True)
    rt = AppRuntime("ws-t2", ws)
    spawned = {"n": 0}

    # Sync on purpose: p_resolve_launch became a plain method, and an async mock here returns a
    # never-awaited coroutine whose body (the counter) never runs, failing the assert at 0.
    def p_no_spawn(env):
        spawned["n"] += 1
        return None, ws, "stub"
    monkeypatch.setattr(rt, "p_resolve_launch", p_no_spawn)
    try:
        asyncio.run(rt.start())
    except Exception:
        pass
    assert rt.serve_static is False and spawned["n"] == 1


def p_manager_no_watcher(monkeypatch):
    # The restart-sentinel watcher is a forever loop; tests must not arm it or asyncio.run leaks a task.
    monkeypatch.setattr(AppRuntimeManager, "p_ensure_restart_watcher", lambda self: None)
    return AppRuntimeManager()


def test_ensure_editing_flips_serve_runtime_to_vite(tmp_path, monkeypatch):
    ws = p_seed(tmp_path)
    mgr = p_manager_no_watcher(monkeypatch)
    rt = AppRuntime("ws-t", ws)
    rt.serve_static = True
    restarted = {"n": 0}

    async def p_fake_start():
        restarted["n"] += 1
        return True
    monkeypatch.setattr(rt, "start", p_fake_start)
    mgr.runtimes["ws-t"] = rt
    asyncio.run(mgr.ensure_editing(ws))
    assert rt.serve_static is False and restarted["n"] == 1


def test_attach_recheck_reboots_when_dist_goes_stale(tmp_path, monkeypatch):
    ws = p_seed(tmp_path)
    mgr = p_manager_no_watcher(monkeypatch)
    rt = AppRuntime("ws-t", ws)
    rt.serve_static = True
    restarted = {"n": 0}

    async def p_fake_start():
        restarted["n"] += 1
        return True
    monkeypatch.setattr(rt, "start", p_fake_start)
    mgr.runtimes["ws-t"] = rt

    monkeypatch.setattr(static_serve, "workspace_being_edited", lambda p: False)
    asyncio.run(mgr.attach("ws-t", ws))
    assert rt.serve_static is True and restarted["n"] == 0

    time.sleep(0.02)
    os.utime(os.path.join(ws, "frontend", "src", "App.tsx"))
    asyncio.run(mgr.attach("ws-t", ws))
    assert rt.serve_static is False and restarted["n"] == 1
