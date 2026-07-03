"""9Router resilience: the watchdog revives a dead router (backing off on repeated failure and
dying with stop()), and provider DETECTION revives before concluding "no provider" — gated on
evidence so a zero-config user never boots a router with nothing to route."""

import asyncio
import json
import os
from unittest.mock import patch

import pytest

import backend.apps.nine_router.process as proc
from backend.apps.settings.models import AppSettings


def test_watchdog_revives_then_backs_off():
    async def run():
        sleeps: list = []
        ensures: list = []

        async def fake_sleep(d):
            sleeps.append(d)
            await real_sleep(0)

        async def fake_ensure():
            ensures.append(1)

        real_sleep = asyncio.sleep
        with patch.object(proc, "is_running", return_value=False), \
             patch.object(proc, "ensure_running", fake_ensure), \
             patch.object(proc.asyncio, "sleep", fake_sleep):
            task = asyncio.get_running_loop().create_task(proc.p_watchdog_loop())
            while len(sleeps) < 6:
                await real_sleep(0)
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        assert len(ensures) >= 3, "a down router must be revived on every pulse"
        assert sleeps[0] == proc.P_WATCHDOG_INTERVAL_SECONDS
        assert sleeps[4] == proc.P_WATCHDOG_BACKOFF_SECONDS, "3 straight failures must back off"

    asyncio.run(run())


def test_watchdog_healthy_router_never_spawns():
    async def run():
        sleeps: list = []
        ensures: list = []

        async def fake_sleep(d):
            sleeps.append(d)
            await real_sleep(0)

        async def fake_ensure():
            ensures.append(1)

        real_sleep = asyncio.sleep
        with patch.object(proc, "is_running", return_value=True), \
             patch.object(proc, "ensure_running", fake_ensure), \
             patch.object(proc.asyncio, "sleep", fake_sleep):
            task = asyncio.get_running_loop().create_task(proc.p_watchdog_loop())
            while len(sleeps) < 4:
                await real_sleep(0)
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        assert not ensures
        assert all(d == proc.P_WATCHDOG_INTERVAL_SECONDS for d in sleeps)

    asyncio.run(run())


def test_stop_cancels_watchdog():
    async def run():
        async def forever():
            while True:
                await asyncio.sleep(3600)

        proc.p_watchdog_task = asyncio.get_running_loop().create_task(forever())
        proc.stop()
        assert proc.p_watchdog_task is None

    asyncio.run(run())


def test_has_persisted_connections(tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    assert proc.has_persisted_connections() is False  # no db at all
    (tmp_path / "db.json").write_text(json.dumps({"providerConnections": [{"provider": "claude", "isActive": False}]}))
    assert proc.has_persisted_connections() is False  # inactive only
    (tmp_path / "db.json").write_text(json.dumps({"providerConnections": [{"provider": "claude", "isActive": True}]}))
    assert proc.has_persisted_connections() is True
    (tmp_path / "db.json").write_text("{corrupt")
    assert proc.has_persisted_connections() is False  # fail-closed


def test_detection_revival_gated_on_evidence():
    from backend.apps.agents.manager import configure_provider_env as cpe

    async def run():
        ensures: list = []

        async def fake_ensure():
            ensures.append(1)

        import backend.apps.nine_router as nr_pkg
        with patch.object(nr_pkg, "is_running", return_value=False), \
             patch.object(nr_pkg, "ensure_running", fake_ensure), \
             patch.object(proc, "has_persisted_connections", return_value=False):
            # Zero-config: no keys, no proxy mode, no persisted connections -> no revival attempt.
            assert await cpe.p_router_available(AppSettings()) is False
            assert not ensures
            # A persisted subscription connection alone IS evidence -> revival attempted.
            with patch.object(proc, "has_persisted_connections", return_value=True):
                assert await cpe.p_router_available(AppSettings()) is False  # ensure failed (router stays down)
                assert ensures, "sub-only users must get a revival attempt"

    asyncio.run(run())
