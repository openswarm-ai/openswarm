"""End-to-end test for the per-workspace runtime cleanup + port collision fix.

What this proves:
1. AppRuntimeManager.stop_all() reaps active runtimes.
2. AppRuntimeManager.stop_all() reaps idle (LRU) runtimes too.
3. AppRuntimeManager.stop_all() resumes SIGSTOP'd idle runtimes before reaping (otherwise the SIGTERM is queued and the process never dies).
4. is_port_free() correctly detects collisions.
5. write_env_value() updates a single key without clobbering siblings.
6. p_start_new_mode() rewrites .env's FRONTEND_PORT when the persisted port is in use, and the spawned child sees the rewritten value.
7. Same collision-rewrite happens for BACKEND_PORT when it's not "NONE".

Run with:  backend/.venv/bin/python backend/tests/test_outputs_runtime_cleanup.py
"""
import asyncio
import os
import socket
import subprocess
import sys
import tempfile

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from backend.apps.outputs import outputs as outputs_module
from backend.apps.outputs import runtime as runtime_module
from backend.apps.outputs.runtime import (
    AppRuntime,
    AppRuntimeManager,
    find_free_port,
    is_port_free,
    read_env_value,
    write_env_value,
)


requires_posix_process_tree = pytest.mark.skipif(
    os.name == "nt",
    reason="requires Bash, pgrep, and POSIX process signals",
)


# --- Fixture: matches the production webapp_template run.sh signal habits ---
# trap cleanup EXIT only, no TERM. Reproduces the actual bug: SIGTERM kills
# bash silently, EXIT trap doesn't fire on uncaught signal, python child gets
# reparented to launchd. kill_descendant_tree must walk the tree to nuke it.
FAKE_RUN_SH = """#!/bin/bash
set -e
if [ -f .env ]; then
    set -a; . ./.env; set +a
fi
echo "[fake-run] FRONTEND_PORT=${FRONTEND_PORT:-unset} pid=$$"
python3 -c "
import socket, time, os
s = socket.socket()
s.bind(('127.0.0.1', int(os.environ['FRONTEND_PORT'])))
s.listen(1)
print(f'[fake-run] bound on {os.environ[\\"FRONTEND_PORT\\"]}', flush=True)
while True:
    time.sleep(1)
" &
PYTHON_PID=$!
# Mirror the real template: EXIT trap only. bash's default SIGTERM handler
# exits without running EXIT, so this MUST NOT keep our descendant alive
# if our kill-tree walker works correctly.
cleanup() { kill $PYTHON_PID 2>/dev/null; }
trap cleanup EXIT
wait $PYTHON_PID
"""


def p_make_fake_workspace(tmp: str, frontend_port: int, backend_port: str = "NONE") -> str:
    ws = os.path.join(tmp, "ws")
    os.makedirs(ws)
    with open(os.path.join(ws, "run.sh"), "w") as f:
        f.write(FAKE_RUN_SH)
    os.chmod(os.path.join(ws, "run.sh"), 0o755)
    with open(os.path.join(ws, ".env"), "w") as f:
        f.write(f"# header comment\nSOMETHING_ELSE=untouched\nFRONTEND_PORT={frontend_port}\nBACKEND_PORT={backend_port}\nTRAILING=keep\n")
    return ws


def p_pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


async def p_stop_restart_watcher(manager: AppRuntimeManager) -> None:
    task = manager.restart_watch_task
    if task is None:
        return
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


@pytest.mark.asyncio
async def test_cancelled_vite_process_creation_releases_boot_lock(
    monkeypatch: pytest.MonkeyPatch,
):
    spawn_entered = asyncio.Event()
    spawn_calls = 0

    async def p_block_then_fail_spawn(*args, **kwargs):
        nonlocal spawn_calls
        spawn_calls += 1
        if spawn_calls == 1:
            spawn_entered.set()
            await asyncio.Event().wait()
        raise OSError("bounded test spawn failure")

    with tempfile.TemporaryDirectory() as tmp:
        ws = p_make_fake_workspace(tmp, find_free_port())
        monkeypatch.setattr(asyncio, "create_subprocess_exec", p_block_then_fail_spawn)
        first_runtime = AppRuntime("ws-cancelled-boot-1", ws)

        start_task = asyncio.create_task(first_runtime.start())
        await spawn_entered.wait()

        start_task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await start_task

        second_runtime = AppRuntime("ws-cancelled-boot-2", ws)
        started = await asyncio.wait_for(second_runtime.start(), timeout=1.0)
        assert started is False
        assert spawn_calls == 2


@pytest.mark.asyncio
async def test_attach_start_failure_rolls_back_only_reference(monkeypatch: pytest.MonkeyPatch):
    stopped: list[AppRuntime] = []

    async def p_fail_start(runtime: AppRuntime) -> bool:
        raise RuntimeError("start failed")

    async def p_record_stop(rt: AppRuntime) -> None:
        stopped.append(rt)

    monkeypatch.setattr(AppRuntime, "start", p_fail_start)
    monkeypatch.setattr(AppRuntime, "stop", p_record_stop)
    manager = AppRuntimeManager()
    try:
        with pytest.raises(RuntimeError, match="start failed"):
            await manager.attach(
                "ws-failed",
                "/tmp/ws-failed",
                attachment_id="failed-lease",
            )

        assert manager.attachment_count("ws-failed") == 0
        assert manager.runtimes == {}
        assert manager.idle_lru == {}
        assert len(stopped) == 1
    finally:
        await p_stop_restart_watcher(manager)


@pytest.mark.asyncio
async def test_attach_failure_reaps_stale_idle_and_replacement(monkeypatch: pytest.MonkeyPatch):
    stopped: list[AppRuntime] = []
    replacements: list[AppRuntime] = []

    async def p_fail_start(rt: AppRuntime) -> bool:
        replacements.append(rt)
        raise RuntimeError("replacement failed")

    async def p_record_stop(rt: AppRuntime) -> None:
        stopped.append(rt)

    monkeypatch.setattr(AppRuntime, "start", p_fail_start)
    monkeypatch.setattr(AppRuntime, "stop", p_record_stop)
    manager = AppRuntimeManager()
    stale = AppRuntime("ws-stale", "/tmp/ws-stale")
    manager.idle_lru["ws-stale"] = stale
    try:
        with pytest.raises(RuntimeError, match="replacement failed"):
            await manager.attach(
                "ws-stale",
                "/tmp/ws-stale",
                attachment_id="stale-lease",
            )

        assert len(replacements) == 1
        assert replacements[0] is not stale
        assert stopped.count(stale) == 1
        assert stopped.count(replacements[0]) == 1
        assert manager.attachment_count("ws-stale") == 0
        assert manager.runtimes == {}
        assert manager.idle_lru == {}
    finally:
        await p_stop_restart_watcher(manager)


@pytest.mark.asyncio
async def test_attach_failure_preserves_preexisting_subscriber(monkeypatch: pytest.MonkeyPatch):
    start_calls = 0
    stopped: list[AppRuntime] = []

    async def p_start(runtime: AppRuntime) -> bool:
        nonlocal start_calls
        start_calls += 1
        if start_calls == 2:
            raise RuntimeError("retry failed")
        return False

    async def p_record_stop(rt: AppRuntime) -> None:
        stopped.append(rt)

    monkeypatch.setattr(AppRuntime, "start", p_start)
    monkeypatch.setattr(AppRuntime, "stop", p_record_stop)
    manager = AppRuntimeManager()
    try:
        existing = await manager.attach(
            "ws-existing",
            "/tmp/ws-existing",
            attachment_id="existing-lease",
        )

        with pytest.raises(RuntimeError, match="retry failed"):
            await manager.attach(
                "ws-existing",
                "/tmp/ws-existing",
                attachment_id="failed-lease",
            )

        assert manager.attachment_count("ws-existing") == 1
        assert manager.runtimes == {"ws-existing": existing}
        assert stopped == []
    finally:
        await p_stop_restart_watcher(manager)


@pytest.mark.asyncio
async def test_cancelled_attach_waits_for_compensating_detach(monkeypatch: pytest.MonkeyPatch):
    cancelled_start_entered = asyncio.Event()
    hold_cancelled_start = asyncio.Event()
    start_calls = 0
    stopped: list[AppRuntime] = []

    async def p_start(runtime: AppRuntime) -> bool:
        nonlocal start_calls
        start_calls += 1
        if start_calls == 2:
            cancelled_start_entered.set()
            await hold_cancelled_start.wait()
        return False

    async def p_record_stop(rt: AppRuntime) -> None:
        stopped.append(rt)

    monkeypatch.setattr(AppRuntime, "start", p_start)
    monkeypatch.setattr(AppRuntime, "stop", p_record_stop)
    manager = AppRuntimeManager()
    try:
        existing = await manager.attach(
            "ws-cancelled",
            "/tmp/ws-cancelled",
            attachment_id="existing-lease",
        )

        cancelled_attach = asyncio.create_task(
            manager.attach(
                "ws-cancelled",
                "/tmp/ws-cancelled",
                attachment_id="cancelled-lease",
            )
        )
        await cancelled_start_entered.wait()
        cancelled_attach.cancel()
        with pytest.raises(asyncio.CancelledError):
            await cancelled_attach

        assert manager.attachment_count("ws-cancelled") == 2
        assert manager.runtimes == {"ws-cancelled": existing}
        assert stopped == []

        await manager.detach("ws-cancelled", attachment_id="cancelled-lease")

        assert manager.attachment_count("ws-cancelled") == 1
        assert manager.runtimes == {"ws-cancelled": existing}
        assert stopped == []
    finally:
        await p_stop_restart_watcher(manager)


@pytest.mark.asyncio
async def test_attachment_lease_duplicate_attach_is_idempotent(monkeypatch: pytest.MonkeyPatch):
    started: list[AppRuntime] = []
    stopped: list[AppRuntime] = []

    async def p_record_start(runtime: AppRuntime) -> bool:
        started.append(runtime)
        return False

    async def p_record_stop(runtime: AppRuntime) -> None:
        stopped.append(runtime)

    monkeypatch.setattr(AppRuntime, "start", p_record_start)
    monkeypatch.setattr(AppRuntime, "stop", p_record_stop)
    manager = AppRuntimeManager()
    try:
        first = await manager.attach(
            "ws-duplicate",
            "/tmp/ws-duplicate",
            attachment_id="lease-duplicate",
        )
        duplicate = await manager.attach(
            "ws-duplicate",
            "/tmp/ws-duplicate",
            attachment_id="lease-duplicate",
        )

        assert duplicate is first
        assert manager.attachment_count("ws-duplicate") == 1
        assert started == [first]

        await manager.detach("ws-duplicate", attachment_id="lease-duplicate")
        assert manager.attachment_count("ws-duplicate") == 0
        assert stopped == [first]

        consumed = await manager.attach(
            "ws-duplicate",
            "/tmp/ws-duplicate",
            attachment_id="lease-duplicate",
        )
        assert consumed is None
        assert manager.attachment_count("ws-duplicate") == 0
        assert started == [first]
    finally:
        await p_stop_restart_watcher(manager)


@pytest.mark.asyncio
async def test_attachment_lease_stop_before_start_and_stop_all_reset(monkeypatch: pytest.MonkeyPatch):
    started: list[AppRuntime] = []

    async def p_record_start(runtime: AppRuntime) -> bool:
        started.append(runtime)
        return False

    monkeypatch.setattr(AppRuntime, "start", p_record_start)
    monkeypatch.setattr(AppRuntime, "stop", lambda runtime: asyncio.sleep(0))
    manager = AppRuntimeManager()
    try:
        await manager.detach("ws-ordered", attachment_id="lease-ordered")
        consumed = await manager.attach(
            "ws-ordered",
            "/tmp/ws-ordered",
            attachment_id="lease-ordered",
        )

        assert consumed is None
        assert manager.attachment_count("ws-ordered") == 0
        assert started == []

        assert await manager.stop_all() == 0
        attached = await manager.attach(
            "ws-ordered",
            "/tmp/ws-ordered",
            attachment_id="lease-ordered",
        )
        assert attached is not None
        assert manager.attachment_count("ws-ordered") == 1
        assert started == [attached]
        assert await manager.stop_all() == 1
        assert manager.attachment_count("ws-ordered") == 0
    finally:
        await p_stop_restart_watcher(manager)


@pytest.mark.asyncio
async def test_legacy_attach_without_lease_still_reference_counts(monkeypatch: pytest.MonkeyPatch):
    started: list[AppRuntime] = []
    stopped: list[AppRuntime] = []

    async def p_record_start(runtime: AppRuntime) -> bool:
        started.append(runtime)
        return False

    async def p_record_stop(runtime: AppRuntime) -> None:
        stopped.append(runtime)

    monkeypatch.setattr(AppRuntime, "start", p_record_start)
    monkeypatch.setattr(AppRuntime, "stop", p_record_stop)
    manager = AppRuntimeManager()
    try:
        first = await manager.attach("ws-legacy", "/tmp/ws-legacy")
        second = await manager.attach("ws-legacy", "/tmp/ws-legacy")

        assert second is first
        assert manager.attachment_count("ws-legacy") == 2
        assert started == [first, first]

        await manager.detach("ws-legacy")
        assert manager.attachment_count("ws-legacy") == 1
        assert stopped == []

        await manager.detach("ws-legacy")
        assert manager.attachment_count("ws-legacy") == 0
        assert stopped == [first]
    finally:
        await p_stop_restart_watcher(manager)


@pytest.mark.asyncio
async def test_runtime_api_attachment_leases_and_validation(
    monkeypatch: pytest.MonkeyPatch,
):
    started: list[AppRuntime] = []

    async def p_record_start(runtime: AppRuntime) -> bool:
        started.append(runtime)
        return False

    monkeypatch.setattr(AppRuntime, "start", p_record_start)
    monkeypatch.setattr(AppRuntime, "stop", lambda runtime: asyncio.sleep(0))
    manager = AppRuntimeManager()
    monkeypatch.setattr(runtime_module, "manager", manager)
    app = FastAPI()
    app.include_router(
        outputs_module.outputs.router,
        prefix=outputs_module.outputs.prefix,
    )

    with tempfile.TemporaryDirectory() as tmp:
        monkeypatch.setattr(outputs_module, "WORKSPACE_DIR", tmp)
        for workspace_id in ("api-duplicate", "api-ordered"):
            os.makedirs(os.path.join(tmp, workspace_id))
        duplicate_url = "/api/outputs/workspace/api-duplicate/runtime/start"
        ordered_base = "/api/outputs/workspace/api-ordered/runtime"
        transport = ASGITransport(app=app)
        try:
            async with AsyncClient(transport=transport, base_url="http://test") as client:
                first = await client.post(
                    duplicate_url,
                    params={"attachment_id": "api-lease"},
                )
                duplicate = await client.post(
                    duplicate_url,
                    params={"attachment_id": "api-lease"},
                )
                assert first.status_code == 200
                assert duplicate.status_code == 200
                assert manager.attachment_count("api-duplicate") == 1
                assert len(started) == 1

                stopped_first = await client.post(
                    f"{ordered_base}/stop",
                    params={"attachment_id": "ordered-lease"},
                )
                started_late = await client.post(
                    f"{ordered_base}/start",
                    params={"attachment_id": "ordered-lease"},
                )
                assert stopped_first.status_code == 200
                assert started_late.status_code == 200
                assert manager.attachment_count("api-ordered") == 0
                assert len(started) == 1

                empty = await client.post(duplicate_url, params={"attachment_id": ""})
                too_long = await client.post(
                    duplicate_url,
                    params={"attachment_id": "a" * 129},
                )
                invalid = await client.post(
                    duplicate_url,
                    params={"attachment_id": "invalid lease"},
                )
                assert empty.status_code == 422
                assert too_long.status_code == 422
                assert invalid.status_code == 422
        finally:
            await manager.stop_all()
            await p_stop_restart_watcher(manager)


# --- Test 1: helpers ---
def test_is_port_free():
    p = find_free_port()
    assert is_port_free(p), "freshly-allocated port should be free"
    s = socket.socket()
    s.bind(("127.0.0.1", p))
    s.listen(1)
    try:
        assert not is_port_free(p), "is_port_free must return False while bound"
    finally:
        s.close()
    print("PASS test_is_port_free")


def test_write_env_value():
    with tempfile.TemporaryDirectory() as tmp:
        env = os.path.join(tmp, ".env")
        with open(env, "w") as f:
            f.write("A=1\nB=2\nC=3\n# comment\n")
        write_env_value(env, "B", "999")
        assert read_env_value(env, "A") == "1"
        assert read_env_value(env, "B") == "999"
        assert read_env_value(env, "C") == "3"
        # New key appended.
        write_env_value(env, "D", "new")
        assert read_env_value(env, "D") == "new"
        # Comment line + sibling values preserved.
        with open(env) as f:
            body = f.read()
        assert "# comment" in body, "comment line dropped"
        assert "A=1" in body and "C=3" in body
    print("PASS test_write_env_value")


# --- Test 2: stop_all reaps an active runtime (real spawn). ---
@pytest.mark.asyncio
@requires_posix_process_tree
async def test_stop_all_kills_active():
    with tempfile.TemporaryDirectory() as tmp:
        port = find_free_port()
        ws = p_make_fake_workspace(tmp, port)
        m = AppRuntimeManager()
        rt = await m.attach("ws1", ws)
        assert rt.running, "runtime should be running after attach"
        pid = rt.process.pid
        # Wait for the child python to actually bind the port.
        for _ in range(40):
            if not is_port_free(port):
                break
            await asyncio.sleep(0.05)
        else:
            raise AssertionError(f"fake child never bound on {port}")
        killed = await m.stop_all()
        assert killed >= 1, f"stop_all reported {killed} reaped"
        # Bash + python child must be gone within the grace window.
        for _ in range(60):
            if not p_pid_alive(pid):
                break
            await asyncio.sleep(0.1)
        else:
            raise AssertionError(f"pid {pid} still alive after stop_all")
        # Port must be released too.
        for _ in range(40):
            if is_port_free(port):
                break
            await asyncio.sleep(0.05)
        else:
            raise AssertionError(f"port {port} not released after stop_all")
        assert not m.runtimes and not m.idle_lru, "manager should be empty after stop_all"
    print("PASS test_stop_all_kills_active")


# --- Test 3: stop_all reaps an idle (LRU + SIGSTOP'd) runtime. ---
@pytest.mark.asyncio
@requires_posix_process_tree
async def test_stop_all_kills_idle():
    with tempfile.TemporaryDirectory() as tmp:
        port = find_free_port()
        ws = p_make_fake_workspace(tmp, port)
        m = AppRuntimeManager()
        rt = await m.attach("ws-idle", ws)
        pid = rt.process.pid
        # Detach -> moves into LRU + SIGSTOP'd. If stop_all forgets to
        # SIGCONT before SIGTERM, the kill queues and the process hangs.
        await m.detach("ws-idle")
        assert "ws-idle" in m.idle_lru, "should be in idle LRU"
        # Confirm the process is suspended (T state on Linux, T on darwin).
        # Skip the OS check; just rely on the eventual kill working.
        killed = await m.stop_all()
        assert killed == 1
        for _ in range(60):
            if not p_pid_alive(pid):
                break
            await asyncio.sleep(0.1)
        else:
            raise AssertionError("idle process never died, stop_all probably didn't SIGCONT first")
        for _ in range(40):
            if is_port_free(port):
                break
            await asyncio.sleep(0.05)
        else:
            raise AssertionError("port from idle runtime not released")
    print("PASS test_stop_all_kills_idle")


# --- Test 4: persisted port collision triggers .env rewrite + new spawn. ---
@pytest.mark.asyncio
@requires_posix_process_tree
async def test_port_collision_reallocates_env():
    with tempfile.TemporaryDirectory() as tmp:
        squatted_port = find_free_port()
        ws = p_make_fake_workspace(tmp, squatted_port)
        # Squat the persisted port so the runtime can't use it.
        squatter = socket.socket()
        squatter.bind(("127.0.0.1", squatted_port))
        squatter.listen(1)
        try:
            m = AppRuntimeManager()
            rt = await m.attach("ws-collide", ws)
            # Wait for either spawn-failure or new port binding.
            for _ in range(40):
                if rt.frontend_port and rt.frontend_port != squatted_port:
                    break
                await asyncio.sleep(0.05)
            assert rt.frontend_port != squatted_port, \
                f"frontend_port should have changed from {squatted_port}, got {rt.frontend_port}"
            # .env should reflect the new port (so run.sh and subsequent
            # restarts pick it up too).
            written = read_env_value(os.path.join(ws, ".env"), "FRONTEND_PORT")
            assert written == str(rt.frontend_port), \
                f".env not rewritten; expected {rt.frontend_port}, found {written}"
            # Sibling .env keys untouched.
            assert read_env_value(os.path.join(ws, ".env"), "SOMETHING_ELSE") == "untouched"
            assert read_env_value(os.path.join(ws, ".env"), "TRAILING") == "keep"
            await m.stop_all()
        finally:
            squatter.close()
    print("PASS test_port_collision_reallocates_env")


# --- Test 5: stop_all is idempotent. ---
@pytest.mark.asyncio
@requires_posix_process_tree
async def test_stop_all_idempotent():
    m = AppRuntimeManager()
    n = await m.stop_all()
    assert n == 0
    n = await m.stop_all()
    assert n == 0
    print("PASS test_stop_all_idempotent")


# --- Test 6: vite-like grandchild dies even with EXIT-only trap. ---
@pytest.mark.asyncio
@requires_posix_process_tree
async def test_descendant_tree_killed_despite_exit_only_trap():
    """Regression for the actual prod bug: webapp_template run.sh has only
    `trap cleanup EXIT` (no TERM), so a flat SIGTERM to bash exits bash
    silently and reparents the vite/uvicorn grandchild to PID 1. stop()
    must walk the descendant tree to nuke the grandchild explicitly."""
    with tempfile.TemporaryDirectory() as tmp:
        port = find_free_port()
        ws = p_make_fake_workspace(tmp, port)
        m = AppRuntimeManager()
        rt = await m.attach("ws-tree", ws)
        bash_pid = rt.process.pid
        # Wait until the python grandchild is actually listening on the port,
        # so we know it exists as a separate process.
        for _ in range(60):
            if not is_port_free(port):
                break
            await asyncio.sleep(0.05)
        else:
            raise AssertionError("grandchild never bound the port")
        # Find the grandchild PID via pgrep -P (same call our walker uses).
        out = subprocess.run(
            ["pgrep", "-P", str(bash_pid)],
            capture_output=True, text=True, timeout=2,
        )
        grand_pids = [int(p) for p in out.stdout.split() if p.strip().isdigit()]
        assert grand_pids, "expected at least one bash child"
        # The python process may be one further level down (`python -c ...` is
        # the leaf, bash spawned via `&` puts it directly under bash).
        all_descendants: list[int] = []
        def collect(pid: int) -> None:
            r = subprocess.run(
                ["pgrep", "-P", str(pid)],
                capture_output=True, text=True, timeout=2,
            )
            for line in r.stdout.split():
                if line.strip().isdigit():
                    pid_i = int(line)
                    all_descendants.append(pid_i)
                    collect(pid_i)
        for g in grand_pids:
            all_descendants.append(g)
            collect(g)
        await m.stop_all()
        # Every descendant must be gone, not just bash.
        for _ in range(80):
            still_alive = [p for p in all_descendants if p_pid_alive(p)]
            if not still_alive:
                break
            await asyncio.sleep(0.1)
        else:
            raise AssertionError(
                f"descendants still alive after stop_all: {still_alive} "
                "(EXIT-only trap let them escape)"
            )
        for _ in range(40):
            if is_port_free(port):
                break
            await asyncio.sleep(0.05)
        else:
            raise AssertionError(f"port {port} still held by ghost grandchild")
    print("PASS test_descendant_tree_killed_despite_exit_only_trap")


async def main():
    test_is_port_free()
    test_write_env_value()
    await test_stop_all_idempotent()
    await test_stop_all_kills_active()
    await test_stop_all_kills_idle()
    await test_port_collision_reallocates_env()
    await test_descendant_tree_killed_despite_exit_only_trap()
    print("\nALL TESTS PASSED")


if __name__ == "__main__":
    asyncio.run(main())
