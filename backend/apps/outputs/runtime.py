"""Per-workspace persistent backend runtime.

Each App (workspace) has at most one long-running `backend.py` subprocess
managed by `AppRuntime`. Lifetime is reference-counted via the module-level
`manager` singleton: when the first ViewEditor / DashboardViewCard /
TerminalPanel attaches to a workspace, the process is spawned; when the
last detaches, it's terminated. Multiple subscribers share the same
process and the same in-memory log ring buffer.

This replaces the old one-shot `execute_backend_code` model for the
"backend serves real HTTP endpoints" use case. The one-shot path stays
around (see `executor.py`) for legacy `/api/outputs/execute` callers.
"""

import asyncio
import logging
import os
import socket
import sys
from collections import deque
from dataclasses import dataclass
from typing import Callable, Optional

logger = logging.getLogger(__name__)

# Recent log lines kept in memory per runtime. Lets a Terminal tab that
# opens mid-session replay the context that was already printed instead
# of seeing a blank pane. 2000 lines ≈ a few hundred KB at worst —
# bounded and predictable.
_LOG_BUFFER_LINES = 2000

# Seconds to wait after SIGTERM before escalating to SIGKILL. Most
# well-behaved Python servers shut down well under a second; this is the
# upper bound before we move on so a wedged process can't block a
# workspace tear-down forever.
_TERMINATE_GRACE_SECONDS = 3

# How long we'll wait for Vite (or whatever frontend server bash run.sh
# spawns) to bind on FRONTEND_PORT before giving up and reporting the
# frontend as "not ready." Covers cold-start `npm install` (~60-90s on
# typical hardware for the template's dependency set) plus the Vite
# bind itself. After this we keep the runtime running — the user can
# check the Terminal pane to see what went wrong — but stop blocking
# the preview pane on a port that may never come up.
_FRONTEND_BIND_TIMEOUT_SECONDS = 180
_FRONTEND_BIND_POLL_INTERVAL = 0.5


def _find_free_port() -> int:
    """Ask the kernel for an unused localhost port. There's a tiny race
    between this socket closing and the backend re-binding, but we hand
    each port to exactly one runtime so no caller competes for it, and
    the kernel won't immediately recycle a freshly-closed port anyway."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _is_new_mode(workspace_path: str) -> bool:
    """A workspace is "new-mode" (webapp-template scaffold) if it has a
    `run.sh` at its root. Old-mode workspaces are flat `index.html`-only
    apps that pre-date the template swap — they're served by OpenSwarm's
    own `/api/outputs/workspace/{ws}/serve/...` FastAPI route and have an
    optional `backend.py` we spawn directly.

    Single-file probe so the check is cheap to call on every runtime
    start, status query, and serve request."""
    return os.path.isfile(os.path.join(workspace_path, "run.sh"))


def _read_env_value(env_path: str, key: str) -> Optional[str]:
    """Parse one value out of a workspace's `.env` without the cost of a
    full subprocess-source. Strips quotes + trailing comments. Returns
    None if the file or key is missing."""
    if not os.path.exists(env_path):
        return None
    try:
        with open(env_path, encoding="utf-8") as f:
            for raw in f:
                line = raw.strip()
                if not line or line.startswith("#"):
                    continue
                if "=" not in line:
                    continue
                k, _, v = line.partition("=")
                if k.strip() != key:
                    continue
                v = v.strip()
                # Strip an inline `# comment`. Naive — bash semantics are
                # more permissive, but values we write don't contain `#`.
                if "#" in v:
                    v = v.split("#", 1)[0].rstrip()
                if (v.startswith('"') and v.endswith('"')) or (v.startswith("'") and v.endswith("'")):
                    v = v[1:-1]
                return v
    except Exception:
        logger.exception("failed reading %s from %s", key, env_path)
    return None


@dataclass
class LogLine:
    stream: str  # "stdout" | "stderr" | "runtime" (internal status lines)
    text: str


LogSubscriber = Callable[[LogLine], None]


class AppRuntime:
    """Manages one workspace's backend.py subprocess.

    - `port` is None until start() runs; it's set even if backend.py
      doesn't exist (no-op start returns False but the runtime still
      exists so the Terminal pane has a host for [FRONTEND] capture).
    - `running` is True only while the process is alive. Goes False on
      exit, and we surface a "[runtime] backend exited" line so the
      Terminal pane shows it.
    - `log_buffer` is the replay source for new subscribers.
    """

    def __init__(self, workspace_id: str, workspace_path: str):
        self.workspace_id = workspace_id
        self.workspace_path = workspace_path
        # Old-mode: `port` is the backend.py port. New-mode: `port` is
        # the workspace's optional FastAPI backend (only set if
        # BACKEND_PORT!=NONE) and `frontend_port` is the Vite dev
        # server port. Both Nones until start() decides what's there.
        self.port: Optional[int] = None
        self.frontend_port: Optional[int] = None
        # New-mode only: flips True once something is actually listening
        # on frontend_port (we kick off a background poll task in
        # _start_new_mode). frontend_url returns null until this flips,
        # so the preview pane doesn't try to navigate to an unbound port
        # and show a "Site can't be reached" error mid-npm-install.
        self._frontend_ready: bool = False
        self.process: Optional[asyncio.subprocess.Process] = None
        self.log_buffer: deque[LogLine] = deque(maxlen=_LOG_BUFFER_LINES)
        self._subscribers: set[LogSubscriber] = set()
        self._stdout_task: Optional[asyncio.Task] = None
        self._stderr_task: Optional[asyncio.Task] = None
        self._wait_task: Optional[asyncio.Task] = None
        self._frontend_ready_task: Optional[asyncio.Task] = None
        self._lock = asyncio.Lock()

    @property
    def running(self) -> bool:
        return self.process is not None and self.process.returncode is None

    @property
    def has_backend_file(self) -> bool:
        return os.path.exists(os.path.join(self.workspace_path, "backend.py"))

    @property
    def is_new_mode(self) -> bool:
        return _is_new_mode(self.workspace_path)

    @property
    def frontend_url(self) -> Optional[str]:
        # Gated on `_frontend_ready` (set by the background bind-poll
        # task in _start_new_mode) so the preview pane only switches
        # over once Vite is actually accepting connections. Without
        # this, the editor flashes a "Site can't be reached" error
        # while `npm install` is running.
        if self.frontend_port and self._frontend_ready:
            return f"http://127.0.0.1:{self.frontend_port}/"
        return None

    async def start(self) -> bool:
        """Spawn the workspace's runtime. Branches on mode:

        - **New-mode** (`run.sh` at workspace root): spawn `bash run.sh`,
          which reads `.env` for FRONTEND_PORT / BACKEND_PORT and boots
          Vite (+ optional FastAPI). We just pre-read the env so the
          status payload + preview-URL branching has them available
          without waiting for the subprocess to print anything.

        - **Old-mode** (no `run.sh`): spawn `python -u backend.py` if
          present, with `PORT` env var. This is the legacy path —
          unchanged so flat-index.html apps keep working.

        Returns True if a process is running after this call. False is
        legitimate for old-mode workspaces with no backend.py (pure
        frontend served by `/api/outputs/.../serve/`); the runtime still
        exists so the Terminal pane can host `[FRONTEND]` lines.
        """
        async with self._lock:
            if self.running:
                return True

            if self.is_new_mode:
                return await self._start_new_mode()
            return await self._start_old_mode()

    async def _start_new_mode(self) -> bool:
        env_path = os.path.join(self.workspace_path, ".env")
        fp_raw = _read_env_value(env_path, "FRONTEND_PORT")
        bp_raw = _read_env_value(env_path, "BACKEND_PORT")
        # FRONTEND_PORT is allocated by seed_workspace; should always be
        # a number. If missing, log + fall back to a fresh allocation —
        # rare edge case (workspace seeded by an older OpenSwarm).
        try:
            self.frontend_port = int(fp_raw) if fp_raw else _find_free_port()
        except ValueError:
            self.frontend_port = _find_free_port()
        # BACKEND_PORT may be the literal string "NONE" (frontend-only
        # app — the common case) or a number once `backend_init.sh` has
        # run. Only populate self.port when there's a real backend.
        if bp_raw and bp_raw != "NONE":
            try:
                self.port = int(bp_raw)
            except ValueError:
                self.port = None
        else:
            self.port = None

        env = self._spawn_env_base()
        # bash run.sh reads .env itself; we don't need to set
        # FRONTEND_PORT / BACKEND_PORT here. We DO export the install
        # paths so the template's `backend/run.sh` can find our
        # debugger to satisfy its `from swarm_debug import debug`.
        # (Also written into .env at seed time, but env-var path is
        # the more reliable read site for subshells.)
        # NOTE: keep these in sync with seed_webapp_template_workspace.
        from backend.apps.outputs.view_builder_templates import (
            _DEBUGGER_PATH,
            _TEMPLATE_BACKEND_PATH,
        )
        env["OPENSWARM_DEBUGGER_PATH"] = _DEBUGGER_PATH
        env["OPENSWARM_TEMPLATE_BACKEND_PATH"] = _TEMPLATE_BACKEND_PATH

        try:
            self.process = await asyncio.create_subprocess_exec(
                "bash", "run.sh",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=self.workspace_path,
                env=env,
            )
        except Exception as e:
            logger.exception("failed to start new-mode runtime for %s", self.workspace_id)
            self._broadcast(LogLine("runtime", f"[runtime] failed to start: {e}"))
            self.frontend_port = None
            self.port = None
            self.process = None
            return False
        backend_note = f" + backend on {self.port}" if self.port else ""
        self._broadcast(LogLine("runtime", f"[runtime] bash run.sh started — frontend on {self.frontend_port}{backend_note} (pid {self.process.pid})"))
        self._stdout_task = asyncio.create_task(self._pipe_stream(self.process.stdout, "stdout"))
        self._stderr_task = asyncio.create_task(self._pipe_stream(self.process.stderr, "stderr"))
        self._wait_task = asyncio.create_task(self._await_exit())
        # Kick off the port-bind poller so frontend_url flips on once
        # Vite is actually accepting connections.
        self._frontend_ready = False
        self._frontend_ready_task = asyncio.create_task(self._await_frontend_bind())
        return True

    async def _await_frontend_bind(self) -> None:
        """Poll `frontend_port` every _FRONTEND_BIND_POLL_INTERVAL until
        something binds (Vite dev server) or we hit the timeout. Emits a
        `[runtime]` log line on success/failure so the Terminal pane
        shows the transition; flips `_frontend_ready` which the
        `frontend_url` property reads."""
        if not self.frontend_port:
            return
        port = self.frontend_port
        deadline = asyncio.get_event_loop().time() + _FRONTEND_BIND_TIMEOUT_SECONDS
        while asyncio.get_event_loop().time() < deadline:
            # Stop polling if the process died — pointless to keep
            # checking a port nothing will bind.
            if self.process is None or self.process.returncode is not None:
                return
            try:
                # asyncio.open_connection is the non-blocking equivalent
                # of socket.create_connection. 0.5s connect timeout to
                # avoid hanging if the host's TCP stack is under load.
                fut = asyncio.open_connection("127.0.0.1", port)
                reader, writer = await asyncio.wait_for(fut, timeout=0.5)
                writer.close()
                try:
                    await writer.wait_closed()
                except Exception:
                    pass
                self._frontend_ready = True
                self._broadcast(LogLine(
                    "runtime",
                    f"[runtime] frontend ready at http://127.0.0.1:{port}/",
                ))
                return
            except (OSError, asyncio.TimeoutError):
                pass
            await asyncio.sleep(_FRONTEND_BIND_POLL_INTERVAL)
        # Timed out — keep the runtime up (Terminal might show useful
        # errors) but surface why the preview never appeared.
        self._broadcast(LogLine(
            "runtime",
            f"[runtime] frontend did NOT bind on port {port} after "
            f"{_FRONTEND_BIND_TIMEOUT_SECONDS}s — check the Terminal "
            f"for npm/vite errors.",
        ))

    async def _start_old_mode(self) -> bool:
        if not self.has_backend_file:
            self.port = None
            return False
        self.port = _find_free_port()
        env = self._spawn_env_base()
        env["PORT"] = str(self.port)
        env["BACKEND_PORT"] = str(self.port)  # alias — both common names work
        try:
            # -u forces unbuffered stdout/stderr so the Terminal pane
            # sees lines in real time, not whenever Python decides to
            # flush its block buffer.
            self.process = await asyncio.create_subprocess_exec(
                sys.executable, "-u", "backend.py",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=self.workspace_path,
                env=env,
            )
        except Exception as e:
            logger.exception("failed to start backend for %s", self.workspace_id)
            self._broadcast(LogLine("runtime", f"[runtime] failed to start: {e}"))
            self.port = None
            self.process = None
            return False
        self._broadcast(LogLine("runtime", f"[runtime] backend started on port {self.port} (pid {self.process.pid})"))
        self._stdout_task = asyncio.create_task(self._pipe_stream(self.process.stdout, "stdout"))
        self._stderr_task = asyncio.create_task(self._pipe_stream(self.process.stderr, "stderr"))
        self._wait_task = asyncio.create_task(self._await_exit())
        return True

    def _spawn_env_base(self) -> dict[str, str]:
        """Inherited env minus the install token. Backend.py can hit our
        REST API back via its own creds if it really needs to, but it
        shouldn't inherit the host process's token by default."""
        return {k: v for k, v in os.environ.items() if k != "OPENSWARM_AUTH_TOKEN"}

    async def stop(self) -> None:
        async with self._lock:
            if not self.process or self.process.returncode is not None:
                # Still cancel the bind poller in case stop() races a
                # never-launched runtime — defensive no-op otherwise.
                if self._frontend_ready_task and not self._frontend_ready_task.done():
                    self._frontend_ready_task.cancel()
                return
            try:
                self.process.terminate()
                try:
                    await asyncio.wait_for(self.process.wait(), timeout=_TERMINATE_GRACE_SECONDS)
                except asyncio.TimeoutError:
                    self.process.kill()
                    await self.process.wait()
            except ProcessLookupError:
                pass
            # Cancel the bind poller so it stops scanning a port that's
            # gone away, and reset the readiness flag.
            if self._frontend_ready_task and not self._frontend_ready_task.done():
                self._frontend_ready_task.cancel()
            self._frontend_ready = False

    async def restart(self) -> bool:
        await self.stop()
        return await self.start()

    def subscribe(self, cb: LogSubscriber) -> Callable[[], None]:
        """Register a log subscriber. Immediately replays the ring buffer
        so a Terminal pane that opens mid-session shows context. Returns
        an unsubscribe function."""
        self._subscribers.add(cb)
        for line in list(self.log_buffer):
            try:
                cb(line)
            except Exception:
                pass

        def _unsub() -> None:
            self._subscribers.discard(cb)

        return _unsub

    def _broadcast(self, line: LogLine) -> None:
        self.log_buffer.append(line)
        # Snapshot subscribers — they can self-remove during dispatch.
        for cb in list(self._subscribers):
            try:
                cb(line)
            except Exception:
                pass

    async def _pipe_stream(self, stream: Optional[asyncio.StreamReader], name: str) -> None:
        if stream is None:
            return
        try:
            while True:
                raw = await stream.readline()
                if not raw:
                    break
                text = raw.decode(errors="replace").rstrip("\r\n")
                if text:
                    self._broadcast(LogLine(name, text))
        except Exception:
            logger.exception("log pipe error (%s) for %s", name, self.workspace_id)

    async def _await_exit(self) -> None:
        if not self.process:
            return
        rc = await self.process.wait()
        self._broadcast(LogLine("runtime", f"[runtime] backend exited with code {rc}"))


class AppRuntimeManager:
    """Per-process singleton tracking all live AppRuntime instances.

    Reference-counts attachments so we don't kill a backend when one
    Terminal closes while another is still subscribed. The first attach
    spawns, the last detach stops."""

    def __init__(self) -> None:
        self.runtimes: dict[str, AppRuntime] = {}
        self._attached: dict[str, int] = {}
        self._lock = asyncio.Lock()

    async def attach(self, workspace_id: str, workspace_path: str) -> AppRuntime:
        async with self._lock:
            rt = self.runtimes.get(workspace_id)
            if rt is None:
                rt = AppRuntime(workspace_id, workspace_path)
                self.runtimes[workspace_id] = rt
            else:
                # Workspace paths shouldn't change for a given id, but if
                # somehow they did (e.g. the user moved the workspace
                # folder), trust the latest caller — they have the
                # current truth.
                rt.workspace_path = workspace_path
            self._attached[workspace_id] = self._attached.get(workspace_id, 0) + 1
        if not rt.running:
            await rt.start()
        return rt

    async def detach(self, workspace_id: str) -> None:
        async with self._lock:
            count = self._attached.get(workspace_id, 0) - 1
            if count > 0:
                self._attached[workspace_id] = count
                return
            self._attached.pop(workspace_id, None)
            rt = self.runtimes.pop(workspace_id, None)
        if rt:
            await rt.stop()

    def get(self, workspace_id: str) -> Optional[AppRuntime]:
        return self.runtimes.get(workspace_id)

    async def restart(self, workspace_id: str, workspace_path: Optional[str] = None) -> Optional[AppRuntime]:
        rt = self.runtimes.get(workspace_id)
        if rt is None:
            return None
        if workspace_path:
            rt.workspace_path = workspace_path
        await rt.restart()
        return rt


manager = AppRuntimeManager()
