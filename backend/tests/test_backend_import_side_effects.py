"""Importing backend.main starts nothing: the App Builder's cache warmup runs as a background task the first
successful health check schedules, once, and not at all in the shell's import probe or on rigs that opt out."""
import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path

from fastapi import BackgroundTasks

from backend.apps.health import health as health_module
from backend.apps.health.health import check as health_check, set_ready_background_task
from backend.apps.outputs import view_builder_templates as template_module


ROOT = Path(__file__).resolve().parents[2]


def p_probe_backend(*, import_only: bool = False, disable_template_warm_cache: bool = False) -> dict:
    env = os.environ.copy()
    env.pop("OPENSWARM_BACKEND_IMPORT_ONLY", None)
    env.pop("OPENSWARM_DISABLE_TEMPLATE_WARM_CACHE", None)
    if import_only:
        env["OPENSWARM_BACKEND_IMPORT_ONLY"] = "1"
    if disable_template_warm_cache:
        env["OPENSWARM_DISABLE_TEMPLATE_WARM_CACHE"] = "1"
    script = """
import asyncio, json, sys, threading
from fastapi import BackgroundTasks
from backend.main import app
from backend.apps.health.health import check as health_check

template_module = sys.modules.get("backend.apps.outputs.view_builder_templates")
background_tasks = BackgroundTasks()
asyncio.run(health_check(background_tasks))
print(json.dumps({
    "routes": sorted(route.path for route in app.routes),
    "template_warm_cache_started": bool(template_module and template_module.p_warm_cache_thread is not None),
    "warm_thread_alive": any(t.name == "webapp-template-warm-cache" for t in threading.enumerate()),
    "health_background_tasks": len(background_tasks.tasks),
}))
"""
    completed = subprocess.run(
        [sys.executable, "-c", script],
        cwd=ROOT,
        env=env,
        check=True,
        capture_output=True,
        text=True,
        timeout=120,
    )
    return json.loads(completed.stdout.strip().splitlines()[-1])


def test_import_starts_nothing_and_the_first_health_check_schedules_the_warmup():
    probe = p_probe_backend()
    assert "/api/outputs/execute" in probe["routes"]
    assert probe["template_warm_cache_started"] is False
    assert probe["warm_thread_alive"] is False
    assert probe["health_background_tasks"] == 1


def test_import_probe_keeps_the_routes_and_schedules_no_warmup():
    probe = p_probe_backend(import_only=True)
    assert "/api/outputs/execute" in probe["routes"]
    assert probe["template_warm_cache_started"] is False
    assert probe["health_background_tasks"] == 0


def test_rigs_can_opt_out_of_the_warmup():
    probe = p_probe_backend(disable_template_warm_cache=True)
    assert "/api/outputs/execute" in probe["routes"]
    assert probe["template_warm_cache_started"] is False
    assert probe["health_background_tasks"] == 0


def test_health_schedules_registered_task_after_response():
    calls: list[str] = []
    previous = health_module.ready_background_task
    set_ready_background_task(lambda: calls.append("started"))
    background_tasks = BackgroundTasks()
    try:
        response = asyncio.run(health_check(background_tasks))
        assert response.status_code == 200
        assert calls == []
        asyncio.run(background_tasks())
        assert calls == ["started"]
    finally:
        set_ready_background_task(previous)


def test_health_without_a_registered_task_schedules_nothing():
    previous = health_module.ready_background_task
    set_ready_background_task(None)
    try:
        background_tasks = BackgroundTasks()
        response = asyncio.run(health_check(background_tasks))
        assert response.status_code == 200
        assert background_tasks.tasks == []
    finally:
        set_ready_background_task(previous)


def test_repeated_warmup_requests_start_one_worker(monkeypatch, tmp_path):
    starts: list[str] = []

    class FakeThread:
        def __init__(self, *, target, daemon, name):
            self.alive = False
            self.target = target
            self.daemon = daemon
            self.name = name

        def is_alive(self):
            return self.alive

        def start(self):
            self.alive = True
            starts.append(self.name)

    monkeypatch.setattr(template_module, "p_warm_cache_thread", None)
    monkeypatch.setattr(template_module, "p_warm_cache_done", False)
    monkeypatch.setattr(template_module, "p_warm_cache_dir", lambda: str(tmp_path))
    monkeypatch.setattr(template_module, "warm_venv_dir", lambda: str(tmp_path))
    monkeypatch.setattr(template_module, "warm_cache_is_complete", lambda path: False)
    monkeypatch.setattr(template_module, "warm_python_venv_is_complete", lambda path: False)
    monkeypatch.setattr(template_module.threading, "Thread", FakeThread)

    template_module.warm_cache_in_background()
    template_module.warm_cache_in_background()

    assert starts == ["webapp-template-warm-cache"]


def test_warmup_stops_checking_once_both_caches_are_complete(monkeypatch, tmp_path):
    checks: list[str] = []
    monkeypatch.setattr(template_module, "p_warm_cache_thread", None)
    monkeypatch.setattr(template_module, "p_warm_cache_done", False)
    monkeypatch.setattr(template_module, "p_warm_cache_dir", lambda: str(tmp_path))
    monkeypatch.setattr(template_module, "warm_venv_dir", lambda: str(tmp_path))
    monkeypatch.setattr(template_module, "warm_cache_is_complete", lambda path: checks.append("node") or True)
    monkeypatch.setattr(template_module, "warm_python_venv_is_complete", lambda path: checks.append("venv") or True)
    monkeypatch.setattr(template_module.threading, "Thread", lambda **kwargs: (_ for _ in ()).throw(AssertionError("no worker expected")))

    template_module.warm_cache_in_background()
    template_module.warm_cache_in_background()
    template_module.warm_cache_in_background()

    assert checks == ["node", "venv"]  # the second and third calls returned without re-checking
