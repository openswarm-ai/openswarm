"""The global vite boot lock must be free again after any start() that did not spawn.

Reported live on 1.7.6-exp.2: the serve-static branch returns True without spawning, the old release
was guarded by `if not ok`, and the only other releaser is the bind-poll task that a serve-static
start never creates. So the FIRST app that qualified for serve-static held the process-global lock
forever and every app opened afterwards blocked on `acquire()` with no error, no traceback and no
non-200: twelve apps stuck on "Starting preview" until a restart. These assert the lock is free after
each non-spawning exit, which is the invariant, rather than asserting the shape of any one branch.
"""

import asyncio
from typing import Any, List
import pytest
from backend.apps.outputs.runtime import AppRuntime, get_vite_boot_lock


def p_make_runtime(tmp_path: Any, name: str = "ws") -> AppRuntime:
    # is_new_mode is a property over the workspace layout: a run.sh at the root is what makes it new.
    ws = tmp_path / name
    ws.mkdir(exist_ok=True)
    (ws / "run.sh").write_text("#!/bin/bash\necho hi\n", encoding="utf-8")
    rt = AppRuntime(workspace_id=name, workspace_path=str(ws))
    assert rt.is_new_mode, "the fixture must build a new-mode workspace or start() takes the old path"
    return rt


@pytest.mark.asyncio
async def test_serve_static_start_leaves_the_boot_lock_free(tmp_path: Any) -> None:
    rt = p_make_runtime(tmp_path)

    async def p_serve_static_exit() -> bool:
        rt.serve_static = True
        return True

    setattr(rt, "p_start_new_mode", p_serve_static_exit)
    assert await rt.start() is True
    assert rt.serve_static is True
    assert not get_vite_boot_lock().locked(), "serve-static start held the global vite boot lock"


@pytest.mark.asyncio
async def test_a_second_app_can_still_start_after_a_serve_static_one(tmp_path: Any) -> None:
    """The actual user-visible failure: app #2 never gets past acquire()."""
    first = p_make_runtime(tmp_path)
    setattr(first, "p_start_new_mode", lambda: p_true_serving(first))
    await first.start()

    second = p_make_runtime(tmp_path, "ws2")
    reached: List[str] = []

    async def p_second_body() -> bool:
        reached.append("spawned")
        return True

    setattr(second, "p_start_new_mode", p_second_body)
    # 2s is generous: without the fix this never returns at all.
    await asyncio.wait_for(second.start(), timeout=2.0)
    assert reached == ["spawned"], "the second app never reached its spawn body"


async def p_true_serving(rt: AppRuntime) -> bool:
    rt.serve_static = True
    return True


@pytest.mark.asyncio
async def test_a_failed_start_leaves_the_boot_lock_free(tmp_path: Any) -> None:
    rt = p_make_runtime(tmp_path)

    async def p_fail() -> bool:
        return False

    setattr(rt, "p_start_new_mode", p_fail)
    assert await rt.start() is False
    assert not get_vite_boot_lock().locked()


@pytest.mark.asyncio
async def test_a_raising_start_leaves_the_boot_lock_free(tmp_path: Any) -> None:
    rt = p_make_runtime(tmp_path)

    async def p_boom() -> bool:
        raise RuntimeError("spawn blew up")

    setattr(rt, "p_start_new_mode", p_boom)
    with pytest.raises(RuntimeError):
        await rt.start()
    assert not get_vite_boot_lock().locked()


@pytest.mark.asyncio
async def test_a_real_spawn_hands_the_lock_to_its_poll_task(tmp_path: Any) -> None:
    """The other direction: a genuine spawn must KEEP the lock, or the serialization it exists for
    is gone and three apps pre-bundle in parallel again."""
    rt = p_make_runtime(tmp_path)

    async def p_spawned() -> bool:
        rt.p_boot_lock_handed_off = True
        return True

    setattr(rt, "p_start_new_mode", p_spawned)
    assert await rt.start() is True
    assert get_vite_boot_lock().locked(), "a real spawn must hold the lock for its bind-poll task"
    get_vite_boot_lock().release()
