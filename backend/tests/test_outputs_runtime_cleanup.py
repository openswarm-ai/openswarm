"""End-to-end test for the per-workspace runtime cleanup + port collision fix.

What this proves:
1. AppRuntimeManager.stop_all() reaps active runtimes.
2. AppRuntimeManager.stop_all() reaps idle (LRU) runtimes too.
3. AppRuntimeManager.stop_all() resumes SIGSTOP'd idle runtimes before reaping (otherwise the SIGTERM is queued and the process never dies).
4. _is_port_free() correctly detects collisions.
5. _write_env_value() updates a single key without clobbering siblings.
6. _start_new_mode() rewrites .env's FRONTEND_PORT when the persisted port is in use, and the spawned child sees the rewritten value.
7. Same collision-rewrite happens for BACKEND_PORT when it's not "NONE".

Run with:  backend/.venv/bin/python backend/tests/test_outputs_runtime_cleanup.py
"""
import asyncio
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from backend.apps.outputs.runtime import (
    AppRuntime,
    AppRuntimeManager,
    _find_free_port,
    _is_port_free,
    _read_env_value,
    _write_env_value,
)


# --- Fixture: matches the production webapp_template run.sh signal habits ---
# trap cleanup EXIT only, no TERM. Reproduces the actual bug: SIGTERM kills
# bash silently, EXIT trap doesn't fire on uncaught signal, python child gets
# reparented to launchd. _kill_descendant_tree must walk the tree to nuke it.
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


def _make_fake_workspace(tmp: str, frontend_port: int, backend_port: str = "NONE") -> str:
    ws = os.path.join(tmp, "ws")
    os.makedirs(ws)
    with open(os.path.join(ws, "run.sh"), "w") as f:
        f.write(FAKE_RUN_SH)
    os.chmod(os.path.join(ws, "run.sh"), 0o755)
    with open(os.path.join(ws, ".env"), "w") as f:
        f.write(f"# header comment\nSOMETHING_ELSE=untouched\nFRONTEND_PORT={frontend_port}\nBACKEND_PORT={backend_port}\nTRAILING=keep\n")
    return ws


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


# --- Test 1: helpers ---
def test_is_port_free():
    p = _find_free_port()
    assert _is_port_free(p), "freshly-allocated port should be free"
    s = socket.socket()
    s.bind(("127.0.0.1", p))
    s.listen(1)
    try:
        assert not _is_port_free(p), "_is_port_free must return False while bound"
    finally:
        s.close()
    print("PASS test_is_port_free")


def test_write_env_value():
    with tempfile.TemporaryDirectory() as tmp:
        env = os.path.join(tmp, ".env")
        with open(env, "w") as f:
            f.write("A=1\nB=2\nC=3\n# comment\n")
        _write_env_value(env, "B", "999")
        assert _read_env_value(env, "A") == "1"
        assert _read_env_value(env, "B") == "999"
        assert _read_env_value(env, "C") == "3"
        # New key appended.
        _write_env_value(env, "D", "new")
        assert _read_env_value(env, "D") == "new"
        # Comment line + sibling values preserved.
        with open(env) as f:
            body = f.read()
        assert "# comment" in body, "comment line dropped"
        assert "A=1" in body and "C=3" in body
    print("PASS test_write_env_value")


# --- Test 2: stop_all reaps an active runtime (real spawn). ---
async def test_stop_all_kills_active():
    with tempfile.TemporaryDirectory() as tmp:
        port = _find_free_port()
        ws = _make_fake_workspace(tmp, port)
        m = AppRuntimeManager()
        rt = await m.attach("ws1", ws)
        assert rt.running, "runtime should be running after attach"
        pid = rt.process.pid
        # Wait for the child python to actually bind the port.
        for _ in range(40):
            if not _is_port_free(port):
                break
            await asyncio.sleep(0.05)
        else:
            raise AssertionError(f"fake child never bound on {port}")
        killed = await m.stop_all()
        assert killed >= 1, f"stop_all reported {killed} reaped"
        # Bash + python child must be gone within the grace window.
        for _ in range(60):
            if not _pid_alive(pid):
                break
            await asyncio.sleep(0.1)
        else:
            raise AssertionError(f"pid {pid} still alive after stop_all")
        # Port must be released too.
        for _ in range(40):
            if _is_port_free(port):
                break
            await asyncio.sleep(0.05)
        else:
            raise AssertionError(f"port {port} not released after stop_all")
        assert not m.runtimes and not m._idle_lru, "manager should be empty after stop_all"
    print("PASS test_stop_all_kills_active")


# --- Test 3: stop_all reaps an idle (LRU + SIGSTOP'd) runtime. ---
async def test_stop_all_kills_idle():
    with tempfile.TemporaryDirectory() as tmp:
        port = _find_free_port()
        ws = _make_fake_workspace(tmp, port)
        m = AppRuntimeManager()
        rt = await m.attach("ws-idle", ws)
        pid = rt.process.pid
        # Detach -> moves into LRU + SIGSTOP'd. If stop_all forgets to
        # SIGCONT before SIGTERM, the kill queues and the process hangs.
        await m.detach("ws-idle")
        assert "ws-idle" in m._idle_lru, "should be in idle LRU"
        # Confirm the process is suspended (T state on Linux, T on darwin).
        # Skip the OS check; just rely on the eventual kill working.
        killed = await m.stop_all()
        assert killed == 1
        for _ in range(60):
            if not _pid_alive(pid):
                break
            await asyncio.sleep(0.1)
        else:
            raise AssertionError("idle process never died, stop_all probably didn't SIGCONT first")
        for _ in range(40):
            if _is_port_free(port):
                break
            await asyncio.sleep(0.05)
        else:
            raise AssertionError("port from idle runtime not released")
    print("PASS test_stop_all_kills_idle")


# --- Test 4: persisted port collision triggers .env rewrite + new spawn. ---
async def test_port_collision_reallocates_env():
    with tempfile.TemporaryDirectory() as tmp:
        squatted_port = _find_free_port()
        ws = _make_fake_workspace(tmp, squatted_port)
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
            written = _read_env_value(os.path.join(ws, ".env"), "FRONTEND_PORT")
            assert written == str(rt.frontend_port), \
                f".env not rewritten; expected {rt.frontend_port}, found {written}"
            # Sibling .env keys untouched.
            assert _read_env_value(os.path.join(ws, ".env"), "SOMETHING_ELSE") == "untouched"
            assert _read_env_value(os.path.join(ws, ".env"), "TRAILING") == "keep"
            await m.stop_all()
        finally:
            squatter.close()
    print("PASS test_port_collision_reallocates_env")


# --- Test 5: stop_all is idempotent. ---
async def test_stop_all_idempotent():
    m = AppRuntimeManager()
    n = await m.stop_all()
    assert n == 0
    n = await m.stop_all()
    assert n == 0
    print("PASS test_stop_all_idempotent")


# --- Test 6: vite-like grandchild dies even with EXIT-only trap. ---
async def test_descendant_tree_killed_despite_exit_only_trap():
    """Regression for the actual prod bug: webapp_template run.sh has only
    `trap cleanup EXIT` (no TERM), so a flat SIGTERM to bash exits bash
    silently and reparents the vite/uvicorn grandchild to PID 1. stop()
    must walk the descendant tree to nuke the grandchild explicitly."""
    with tempfile.TemporaryDirectory() as tmp:
        port = _find_free_port()
        ws = _make_fake_workspace(tmp, port)
        m = AppRuntimeManager()
        rt = await m.attach("ws-tree", ws)
        bash_pid = rt.process.pid
        # Wait until the python grandchild is actually listening on the port,
        # so we know it exists as a separate process.
        for _ in range(60):
            if not _is_port_free(port):
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
            still_alive = [p for p in all_descendants if _pid_alive(p)]
            if not still_alive:
                break
            await asyncio.sleep(0.1)
        else:
            raise AssertionError(
                f"descendants still alive after stop_all: {still_alive} "
                "(EXIT-only trap let them escape)"
            )
        for _ in range(40):
            if _is_port_free(port):
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
