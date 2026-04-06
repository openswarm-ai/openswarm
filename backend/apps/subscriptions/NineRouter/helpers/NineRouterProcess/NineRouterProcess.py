"""Subprocess lifecycle management for the 9Router process.

9Router is a local Node.js proxy that lets users connect their
Claude/ChatGPT/Gemini subscriptions to OpenSwarm without API keys.
"""

import asyncio
import os
import shutil
import subprocess
import threading
from typing import Optional

import httpx
from pydantic import Field, BaseModel
from typeguard import typechecked

from backend.ports import NINE_ROUTER_PORT
from backend.apps.subscriptions.NineRouter.helpers.constants import NINE_ROUTER_V1, NINE_ROUTER_URL
from backend.apps.subscriptions.NineRouter.helpers.NineRouterProcess.helpers.forward_output import forward_output
from backend.apps.subscriptions.NineRouter.helpers.NineRouterProcess.helpers.find_9router_dir import find_9router_dir
from backend.apps.subscriptions.NineRouter.helpers.NineRouterProcess.helpers.find_node import find_node

P_THIS_DIR: str = os.path.dirname(os.path.abspath(__file__))


class NineRouterProcess(BaseModel):
    p_process: Optional[subprocess.Popen] = Field(default=None)

    @typechecked
    def is_running(self) -> bool:
        try:
            r = httpx.get(f"{NINE_ROUTER_V1}/models", timeout=2.0)
            return r.status_code == 200
        except Exception:
            return False

    @typechecked
    async def ensure_running(self) -> None:
        """Start 9Router if not already running."""
        _is_packaged: bool = os.environ.get("OPENSWARM_PACKAGED") == "1"

        if self.is_running():
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

        p_9router_dir: Optional[str] = find_9router_dir(P_THIS_DIR)
        cmd: list[str]
        cwd: str | None
        env: dict[str, str]

        if _is_packaged and p_9router_dir:
            standalone_server: str = os.path.join(p_9router_dir, "server.js")
            if not os.path.exists(standalone_server):
                standalone_server = os.path.join(p_9router_dir, ".next", "standalone", "server.js")
            if not os.path.exists(standalone_server):
                print("9Router: standalone build not found in", p_9router_dir, flush=True)
                return

            node: Optional[str] = find_node()
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

        elif p_9router_dir:
            npx: str | None = shutil.which("npx")
            if not npx:
                print("9Router: npx not found, cannot auto-start", flush=True)
                return

            if not os.path.isdir(os.path.join(p_9router_dir, "node_modules")):
                print("9Router: installing dependencies...", flush=True)
                npm: str | None = shutil.which("npm")
                if npm:
                    subprocess.run(
                        [npm, "install"], cwd=p_9router_dir,
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=120,
                    )

            print(f"9Router: starting (dev) on port {NINE_ROUTER_PORT}...", flush=True)
            cmd = [npx, "next", "dev", "--webpack", "-p", str(NINE_ROUTER_PORT)]
            cwd = p_9router_dir
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
            self.p_process = subprocess.Popen(
                cmd, cwd=cwd,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                env=env,
            )
            threading.Thread(target=forward_output, args=(self.p_process.stdout,), daemon=True).start()

            timeout: int = 20 if _is_packaged else 30
            for _ in range(timeout * 2):
                await asyncio.sleep(0.5)
                if self.is_running():
                    print("9Router: started successfully", flush=True)
                    return

            print(f"9Router: did not start within {timeout}s", flush=True)
        except Exception as e:
            print(f"9Router: failed to start: {e}", flush=True)

    @typechecked
    def stop(self) -> None:
        if self.p_process:
            try:
                self.p_process.terminate()
                self.p_process.wait(timeout=5)
            except Exception:
                try:
                    self.p_process.kill()
                except Exception:
                    pass
            self.p_process = None
            print("9Router stopped")
