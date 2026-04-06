"""Subprocess lifecycle management for the 9Router process.

9Router is a local Node.js proxy that lets users connect their
Claude/ChatGPT/Gemini subscriptions to OpenSwarm without API keys.
"""

import asyncio
import os
import shutil
import subprocess
import threading

import httpx
from typeguard import typechecked

from backend.ports import NINE_ROUTER_PORT
from backend.apps.subscriptions.NineRouter.constants import NINE_ROUTER_V1, NINE_ROUTER_URL

P_PROCESS: subprocess.Popen | None = None
P_THIS_DIR: str = os.path.dirname(os.path.abspath(__file__))


def _forward_output(pipe) -> None:
    try:
        for line in iter(pipe.readline, b""):
            text = line.decode("utf-8", errors="replace").rstrip()
            if text:
                print(f"[9router] {text}", flush=True)
    except Exception:
        pass
    finally:
        try:
            pipe.close()
        except Exception:
            pass


@typechecked
def is_running() -> bool:
    try:
        r = httpx.get(f"{NINE_ROUTER_V1}/models", timeout=2.0)
        return r.status_code == 200
    except Exception:
        return False


@typechecked
def _find_9router_dir() -> str | None:
    """Locate the bundled 9Router directory (dev or packaged)."""
    _is_packaged: bool = os.environ.get("OPENSWARM_PACKAGED") == "1"

    if _is_packaged:
        _resources: str = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(P_THIS_DIR))))
        _candidate: str = os.path.join(_resources, "9router")
        if os.path.isdir(_candidate):
            return _candidate
    else:
        _backend_dir: str = os.path.dirname(os.path.dirname(os.path.dirname(P_THIS_DIR)))
        _project_root: str = os.path.dirname(_backend_dir)
        _candidate = os.path.join(_project_root, "9router")
        if os.path.isdir(_candidate):
            return _candidate

    return None


@typechecked
def _find_node() -> str | None:
    node: str | None = shutil.which("node")
    if node:
        return node
    electron_path: str | None = os.environ.get("OPENSWARM_ELECTRON_PATH")
    if electron_path and os.path.exists(electron_path):
        return electron_path
    return None


@typechecked
async def ensure_running() -> None:
    """Start 9Router if not already running."""
    global P_PROCESS
    _is_packaged: bool = os.environ.get("OPENSWARM_PACKAGED") == "1"

    if is_running():
        if not _is_packaged:
            try:
                result = subprocess.run(
                    ["pgrep", "-f", "next-server"],
                    capture_output=True, text=True, timeout=3,
                )
                if result.stdout.strip():
                    print("9Router: killing stale standalone to use next dev", flush=True)
                    subprocess.run(["pkill", "-f", "next-server"], timeout=5)
                    await asyncio.sleep(2)
                else:
                    return
            except Exception:
                return
        else:
            return

    _9router_dir: str | None = _find_9router_dir()
    cmd: list[str]
    cwd: str | None
    env: dict[str, str]

    if _is_packaged and _9router_dir:
        standalone_server: str = os.path.join(_9router_dir, "server.js")
        if not os.path.exists(standalone_server):
            standalone_server = os.path.join(_9router_dir, ".next", "standalone", "server.js")
        if not os.path.exists(standalone_server):
            print("9Router: standalone build not found in", _9router_dir, flush=True)
            return

        node: str | None = _find_node()
        if not node:
            print("9Router: Node.js not found, cannot start in packaged mode", flush=True)
            return

        print(f"9Router: starting (production) on port {NINE_ROUTER_PORT}...", flush=True)
        cmd = [node, standalone_server]
        cwd = os.path.dirname(standalone_server)
        env = {
            **os.environ,
            "PORT": str(NINE_ROUTER_PORT),
            "NEXT_PUBLIC_BASE_URL": NINE_ROUTER_URL,
            "NODE_ENV": "production",
        }
        if node == os.environ.get("OPENSWARM_ELECTRON_PATH"):
            env["ELECTRON_RUN_AS_NODE"] = "1"

    elif _9router_dir:
        npx: str | None = shutil.which("npx")
        if not npx:
            print("9Router: npx not found, cannot auto-start", flush=True)
            return

        if not os.path.isdir(os.path.join(_9router_dir, "node_modules")):
            print("9Router: installing dependencies...", flush=True)
            npm: str | None = shutil.which("npm")
            if npm:
                subprocess.run(
                    [npm, "install"], cwd=_9router_dir,
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=120,
                )

        print(f"9Router: starting (dev) on port {NINE_ROUTER_PORT}...", flush=True)
        cmd = [npx, "next", "dev", "--webpack", "-p", str(NINE_ROUTER_PORT)]
        cwd = _9router_dir
        env = {
            **os.environ,
            "PORT": str(NINE_ROUTER_PORT),
            "NEXT_PUBLIC_BASE_URL": NINE_ROUTER_URL,
        }

    else:
        npx = shutil.which("npx")
        if not npx:
            print("9Router: npx not found and no bundled 9router directory", flush=True)
            return
        print(f"9Router: starting (npx) on port {NINE_ROUTER_PORT}...", flush=True)
        cmd = [npx, "9router", "--port", str(NINE_ROUTER_PORT), "--no-browser", "--skip-update"]
        cwd = None
        env = {
            **os.environ,
            "PORT": str(NINE_ROUTER_PORT),
            "NEXT_PUBLIC_BASE_URL": NINE_ROUTER_URL,
        }

    try:
        P_PROCESS = subprocess.Popen(
            cmd, cwd=cwd,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            env=env,
        )
        threading.Thread(target=_forward_output, args=(P_PROCESS.stdout,), daemon=True).start()

        timeout: int = 20 if _is_packaged else 30
        for _ in range(timeout * 2):
            await asyncio.sleep(0.5)
            if is_running():
                print("9Router: started successfully", flush=True)
                return

        print(f"9Router: did not start within {timeout}s", flush=True)
    except Exception as e:
        print(f"9Router: failed to start: {e}", flush=True)


@typechecked
def stop() -> None:
    global P_PROCESS
    if P_PROCESS:
        try:
            P_PROCESS.terminate()
            P_PROCESS.wait(timeout=5)
        except Exception:
            try:
                P_PROCESS.kill()
            except Exception:
                pass
        P_PROCESS = None
        print("9Router stopped")
