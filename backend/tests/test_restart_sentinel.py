"""Agent self-restart handshake: a workspace's restart.sh touches
.openswarm/restart-requested and the AppRuntimeManager watcher consumes it and
restarts every attached instance of that workspace. This is the only restart
path an agent has (no API token, uvicorn runs without --reload), so pin both
the pickup and the sentinel consumption restart.sh's wait loop depends on."""

import asyncio
import os

import pytest

from backend.apps.outputs import runtime as runtime_mod
from backend.apps.outputs.runtime import AppRuntime, AppRuntimeManager


@pytest.mark.asyncio
async def test_sentinel_restarts_all_attached_instances(tmp_path, monkeypatch):
    monkeypatch.setattr(runtime_mod, "RESTART_SENTINEL_POLL_SECONDS", 0.05)
    restarted: list[int] = []

    async def p_fake_start(self):
        return True

    async def p_fake_restart(self):
        restarted.append(self.instance)
        return True
    monkeypatch.setattr(AppRuntime, "start", p_fake_start)
    monkeypatch.setattr(AppRuntime, "restart", p_fake_restart)
    # The stub spawns no process; the watcher only restarts live runtimes, so fake liveness.
    monkeypatch.setattr(AppRuntime, "running", property(lambda self: True))

    mgr = AppRuntimeManager()
    ws = str(tmp_path)
    await mgr.attach("ws1", ws, 1)
    await mgr.attach("ws1", ws, 2)

    os.makedirs(os.path.join(ws, ".openswarm"), exist_ok=True)
    sentinel = os.path.join(ws, ".openswarm", "restart-requested")
    with open(sentinel, "w", encoding="utf-8") as f:
        f.write("")

    for _ in range(100):
        await asyncio.sleep(0.05)
        if len(restarted) >= 2:
            break
    # Sentinel consumed (restart.sh's wait loop unblocks) and BOTH instances bounced.
    assert not os.path.exists(sentinel)
    assert sorted(restarted) == [1, 2]

    # No sentinel -> no further restarts.
    await asyncio.sleep(0.2)
    assert sorted(restarted) == [1, 2]
    if mgr.restart_watch_task:
        mgr.restart_watch_task.cancel()
