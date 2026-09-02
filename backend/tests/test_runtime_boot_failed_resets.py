"""A bind timeout stamps boot_failed so the card stops spinning, but the flag lived on the runtime
object forever: after one 180s timeout every later restart of the same runtime kept reporting
boot_failed=True even while ready=True (seen live on an app card, 2026-09-02). start() now clears it."""

import pytest

from backend.apps.outputs.runtime import AppRuntime


def p_rt(tmp_path) -> AppRuntime:
    ws = tmp_path / "ws"
    ws.mkdir(exist_ok=True)
    (ws / "run.sh").write_text("#!/bin/bash\n")
    return AppRuntime(workspace_id="ws-boot-failed", workspace_path=str(ws))


@pytest.mark.asyncio
async def test_a_restart_that_boots_clears_the_previous_bind_timeout(tmp_path, monkeypatch):
    rt = p_rt(tmp_path)
    rt.boot_failed = True

    async def p_fake_spawn() -> bool:
        return True

    monkeypatch.setattr(rt, "p_start_new_mode", p_fake_spawn)
    assert await rt.start() is True
    assert rt.boot_failed is False, "a boot that spawned fine must not keep telling the card the previous one failed"


@pytest.mark.asyncio
async def test_an_already_running_runtime_keeps_its_verdict(tmp_path, monkeypatch):
    rt = p_rt(tmp_path)
    rt.boot_failed = True
    monkeypatch.setattr(type(rt), "running", property(lambda self: True))
    assert await rt.start() is True
    assert rt.boot_failed is True, "start() on a live runtime is a no-op and must not rewrite state"
