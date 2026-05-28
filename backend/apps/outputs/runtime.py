"""Per-workspace persistent backend.py runtime; one AppRuntime per workspace, refcounted by manager singleton."""

import asyncio
import logging
import os
import sys
from collections import deque, OrderedDict
from dataclasses import dataclass
from typing import Callable, Optional

from .runtime_proc import (
    _ERROR_PATTERNS,
    _FRONTEND_BIND_POLL_INTERVAL,
    _FRONTEND_BIND_TIMEOUT_SECONDS,
    _LOG_BUFFER_LINES,
    _MAX_IDLE_RUNTIMES,
    _RECENT_ERRORS_MAX,
    _TERMINATE_GRACE_SECONDS,
    _background_priority_kwargs,
    _find_free_port,
    _is_new_mode,
    _is_port_free,
    _kill_descendant_tree,
    _read_env_value,
    _resume_process_tree,
    _suspend_process_tree,
    _write_env_value,
)

logger = logging.getLogger(__name__)

# Module-level lock so only ONE vite optimizeDeps runs at a time; must be acquired before manager._lock to avoid deadlock with manager.attach.
_vite_boot_lock = asyncio.Lock()


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
        # Recent build/runtime errors scraped from stderr; drained by
        # the agent's post-tool hook after Write/Edit so the agent sees
        # vite/babel/uvicorn errors in its next turn and can self-fix
        # instead of leaving the user with a red iframe overlay.
        self.recent_errors: deque[str] = deque(maxlen=_RECENT_ERRORS_MAX)
        self._stdout_task: Optional[asyncio.Task] = None
        self._stderr_task: Optional[asyncio.Task] = None
        self._wait_task: Optional[asyncio.Task] = None
        self._frontend_ready_task: Optional[asyncio.Task] = None
        self._lock = asyncio.Lock()

    def drain_errors(self) -> list[str]:
        """Pop and return all accumulated error lines. Used by the
        agent-manager's post-tool hook to surface build errors back
        into the agent's context immediately after a file write."""
        out = list(self.recent_errors)
        self.recent_errors.clear()
        return out

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
          present, with `PORT` env var. This is the legacy path , 
          unchanged so flat-index.html apps keep working.

        Returns True if a process is running after this call. False is
        legitimate for old-mode workspaces with no backend.py (pure
        frontend served by `/api/outputs/.../serve/`); the runtime still
        exists so the Terminal pane can host `[FRONTEND]` lines.

        New-mode spawns are serialized through the module-level
        `_vite_boot_lock` (see comment at the lock declaration) so a
        burst of "create 3 apps in 5 seconds" doesn't trigger 3 parallel
        MUI pre-bundle runs each pegging a core.
        """
        async with self._lock:
            if self.running:
                return True

            if self.is_new_mode:
                # Acquire the module-level boot lock BEFORE the spawn so
                # only one new-mode workspace is mid-bundle at a time.
                # The lock is released by the bind-poll task the moment
                # vite emits "frontend ready" (or its 180s timeout
                # fires), which is the moment the next workspace can
                # start its own vite without competing for the same
                # CPU. See `_await_frontend_bind` for the release.
                await _vite_boot_lock.acquire()
                try:
                    ok = await self._start_new_mode()
                    if not ok:
                        # Spawn failed before the bind-poll task was
                        # created; release synchronously so we don't
                        # wedge the next workspace.
                        _vite_boot_lock.release()
                    return ok
                except Exception:
                    _vite_boot_lock.release()
                    raise
            return await self._start_old_mode()

    async def _start_new_mode(self) -> bool:
        env_path = os.path.join(self.workspace_path, ".env")
        fp_raw = _read_env_value(env_path, "FRONTEND_PORT")
        bp_raw = _read_env_value(env_path, "BACKEND_PORT")
        # FRONTEND_PORT is allocated by seed_workspace; should always be
        # a number. If missing, fall back to a fresh allocation (rare
        # edge case: workspace seeded by an older OpenSwarm).
        try:
            self.frontend_port = int(fp_raw) if fp_raw else _find_free_port()
        except ValueError:
            self.frontend_port = _find_free_port()
        # Port-collision safety net: if a ghost subprocess from a prior
        # OpenSwarm run is still bound to the persisted port (force-quit,
        # crash, OS killed the parent before stop_all could reap), Vite
        # would EADDRINUSE silently. Re-probe and reallocate, then rewrite
        # .env so the bash run.sh subprocess reads the new port.
        if self.frontend_port and not _is_port_free(self.frontend_port):
            new_port = _find_free_port()
            self._broadcast(LogLine(
                "runtime",
                f"[runtime] persisted FRONTEND_PORT {self.frontend_port} is in use; reallocating to {new_port}",
            ))
            self.frontend_port = new_port
            _write_env_value(env_path, "FRONTEND_PORT", str(new_port))
        # BACKEND_PORT may be the literal string "NONE" (frontend-only
        # app; the common case) or a number once `backend_init.sh` has
        # run. Only populate self.port when there's a real backend.
        if bp_raw and bp_raw != "NONE":
            try:
                self.port = int(bp_raw)
            except ValueError:
                self.port = None
            # Same collision check for the backend port; a leaked uvicorn
            # from a prior session would otherwise block the new spawn.
            if self.port and not _is_port_free(self.port):
                new_port = _find_free_port()
                self._broadcast(LogLine(
                    "runtime",
                    f"[runtime] persisted BACKEND_PORT {self.port} is in use; reallocating to {new_port}",
                ))
                self.port = new_port
                _write_env_value(env_path, "BACKEND_PORT", str(new_port))
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
                **_background_priority_kwargs(),
            )
        except Exception as e:
            logger.exception("failed to start new-mode runtime for %s", self.workspace_id)
            self._broadcast(LogLine("runtime", f"[runtime] failed to start: {e}"))
            self.frontend_port = None
            self.port = None
            self.process = None
            return False
        backend_note = f" + backend on {self.port}" if self.port else ""
        self._broadcast(LogLine("runtime", f"[runtime] bash run.sh started; frontend on {self.frontend_port}{backend_note} (pid {self.process.pid})"))
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
        `frontend_url` property reads.

        Also responsible for releasing the module-level `_vite_boot_lock`
       ; every exit path (success, process death, hard timeout) MUST
        release exactly once so the next queued workspace can start its
        own vite spawn. A try/finally on the lock guarantees that even
        an exception in the poll body doesn't strand the lock holding."""
        # Track whether we've already released so the cleanup at the
        # end doesn't double-release if a success path beat it.
        lock_released = False

        def _release_boot_lock() -> None:
            nonlocal lock_released
            if lock_released:
                return
            lock_released = True
            try:
                _vite_boot_lock.release()
            except RuntimeError:
                # Lock already released (e.g. start() failure path
                # released synchronously before spawning the poll task).
                pass

        try:
            if not self.frontend_port:
                return
            port = self.frontend_port
            deadline = asyncio.get_event_loop().time() + _FRONTEND_BIND_TIMEOUT_SECONDS
            while asyncio.get_event_loop().time() < deadline:
                # Stop polling if the process died; pointless to keep
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
                    # Release the vite-boot mutex the INSTANT vite is
                    # ready; the next queued workspace can start its
                    # own bundle now even though we'll keep streaming
                    # logs for this one.
                    _release_boot_lock()
                    return
                except (OSError, asyncio.TimeoutError):
                    pass
                await asyncio.sleep(_FRONTEND_BIND_POLL_INTERVAL)
            # Timed out; keep the runtime up (Terminal might show useful
            # errors) but surface why the preview never appeared.
            self._broadcast(LogLine(
                "runtime",
                f"[runtime] frontend did NOT bind on port {port} after "
                f"{_FRONTEND_BIND_TIMEOUT_SECONDS}s; check the Terminal "
                f"for npm/vite errors.",
            ))
        finally:
            # Catches process-death return, timeout fall-through, and
            # any exception in the poll body. _release_boot_lock is
            # idempotent so this is safe even after the success path
            # already released.
            _release_boot_lock()

    async def _start_old_mode(self) -> bool:
        if not self.has_backend_file:
            self.port = None
            return False
        self.port = _find_free_port()
        env = self._spawn_env_base()
        env["PORT"] = str(self.port)
        env["BACKEND_PORT"] = str(self.port)  # alias; both common names work
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
                **_background_priority_kwargs(),
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
                # never-launched runtime; defensive no-op otherwise.
                if self._frontend_ready_task and not self._frontend_ready_task.done():
                    self._frontend_ready_task.cancel()
                return
            try:
                # Walk the descendant tree first so vite/uvicorn grandchildren
                # die before bash exits and orphans them to PID 1. The webapp
                # template's run.sh only traps EXIT, not TERM, so a flat
                # SIGTERM to bash kills bash silently and leaves vite alive.
                _kill_descendant_tree(self.process.pid, "TERM")
                self.process.terminate()
                try:
                    await asyncio.wait_for(self.process.wait(), timeout=_TERMINATE_GRACE_SECONDS)
                except asyncio.TimeoutError:
                    _kill_descendant_tree(self.process.pid, "KILL")
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
        # Snapshot subscribers; they can self-remove during dispatch.
        for cb in list(self._subscribers):
            try:
                cb(line)
            except Exception:
                pass

    def _maybe_capture_error(self, text: str) -> None:
        """If a stderr/stdout line matches a known build-error pattern,
        record it for the next agent-tool drain. Tests every line , 
        cheap (single regex search) and only the matching ones land in
        the buffer."""
        if _ERROR_PATTERNS.search(text):
            self.recent_errors.append(text.rstrip())

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
                    if name == "stderr" or name == "stdout":
                        self._maybe_capture_error(text)
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
    Terminal closes while another is still subscribed. First attach
    spawns; final detach moves the runtime into an LRU idle pool
    instead of stopping it immediately; so re-clicking a recent App
    is instant. The oldest runtime gets reaped once the pool exceeds
    _MAX_IDLE_RUNTIMES."""

    def __init__(self) -> None:
        # workspace_id → AppRuntime, currently has >=1 subscriber.
        self.runtimes: dict[str, AppRuntime] = {}
        self._attached: dict[str, int] = {}
        # workspace_id → AppRuntime with no subscribers but still
        # alive. OrderedDict gives O(1) move_to_end + popitem(last=False)
        # for LRU semantics.
        self._idle_lru: "OrderedDict[str, AppRuntime]" = OrderedDict()
        self._lock = asyncio.Lock()

    async def attach(self, workspace_id: str, workspace_path: str) -> AppRuntime:
        revived = False
        # Defined here so every code path below leaves it bound; the
        # revive-idle branch used to skip the assignment, leaving the
        # post-lock `if dead is not None:` check throwing UnboundLocalError.
        dead: Optional[AppRuntime] = None
        async with self._lock:
            rt = self.runtimes.get(workspace_id)
            if rt is None:
                # Maybe the runtime is sitting idle in the LRU; revive
                # it without paying the spawn cost again.
                idle_rt = self._idle_lru.pop(workspace_id, None)
                if idle_rt is not None and idle_rt.running:
                    rt = idle_rt
                    rt.workspace_path = workspace_path
                    self.runtimes[workspace_id] = rt
                    revived = True
                    # SIGCONT the process tree if A2 had it paused while
                    # idle. Pair with the SIGSTOP in detach() below.
                    _resume_process_tree(rt.process)
                else:
                    if idle_rt is not None:
                        # Stale idle entry; process died while idling.
                        # Drop and spawn a fresh one below; old one
                        # gets stopped outside the lock.
                        dead = idle_rt
                    rt = AppRuntime(workspace_id, workspace_path)
                    self.runtimes[workspace_id] = rt
            else:
                # Workspace paths shouldn't change for a given id, but if
                # somehow they did (e.g. the user moved the workspace
                # folder), trust the latest caller; they have the
                # current truth.
                rt.workspace_path = workspace_path
            self._attached[workspace_id] = self._attached.get(workspace_id, 0) + 1
        if not revived and not rt.running:
            await rt.start()
        # Stop any dead idle runtime outside the lock to avoid blocking.
        if dead is not None:
            try:
                await dead.stop()
            except Exception:
                logger.exception("failed to reap dead idle runtime %s", workspace_id)
        return rt

    async def detach(self, workspace_id: str) -> None:
        to_idle: Optional[AppRuntime] = None
        to_reap: list[AppRuntime] = []
        async with self._lock:
            count = self._attached.get(workspace_id, 0) - 1
            if count > 0:
                self._attached[workspace_id] = count
                return
            self._attached.pop(workspace_id, None)
            rt = self.runtimes.pop(workspace_id, None)
            if rt is None:
                return
            # If the process is already dead, no point keeping it
            # around; just clean up. Otherwise move to the LRU AND
            # SIGSTOP the process tree so it consumes 0% CPU while
            # idle. The matching SIGCONT lives in attach() above.
            if not rt.running:
                to_reap.append(rt)
            else:
                self._idle_lru[workspace_id] = rt
                self._idle_lru.move_to_end(workspace_id)
                _suspend_process_tree(rt.process)
                while len(self._idle_lru) > _MAX_IDLE_RUNTIMES:
                    _, old_rt = self._idle_lru.popitem(last=False)
                    # Reaping a stopped process: SIGCONT first so the
                    # SIGTERM in stop() can be delivered cleanly (a
                    # SIGSTOP'd process can't run its own shutdown).
                    _resume_process_tree(old_rt.process)
                    to_reap.append(old_rt)
            to_idle = rt if rt.running else None

        # Stop any reaped runtimes OUTSIDE the lock. stop() is async and
        # can take up to _TERMINATE_GRACE_SECONDS; holding the lock for
        # it would block every other attach/detach.
        for old in to_reap:
            try:
                await old.stop()
            except Exception:
                logger.exception("failed to reap idle runtime %s", workspace_id)
        if to_idle is not None:
            logger.debug("workspace %s idled (LRU size now %d)", workspace_id, len(self._idle_lru))

    def get(self, workspace_id: str) -> Optional[AppRuntime]:
        # Active subscribers see the live runtime; idle-pool members
        # are also accessible so a status probe between detach and
        # the next attach still works.
        rt = self.runtimes.get(workspace_id)
        if rt is not None:
            return rt
        return self._idle_lru.get(workspace_id)

    def drain_errors_for_path(self, file_path: str) -> list[str]:
        """If `file_path` falls under one of the live workspace
        runtimes' workspace_path, drain that workspace's recent
        build/runtime errors. Returns [] if no workspace owns the path
        or no errors are queued; caller can treat empty as 'all clear'.
        Used by agent_manager's post-tool hook so the agent sees vite /
        babel / uvicorn errors right after a Write/Edit completes."""
        if not file_path:
            return []
        try:
            abs_path = os.path.abspath(file_path)
        except Exception:
            return []
        # Walk both active and idle runtimes; the user might have
        # navigated away from the workspace mid-build, but the agent
        # could still be editing files; the LRU keeps the runtime alive
        # for ~3 idle slots.
        for rt in (*self.runtimes.values(), *self._idle_lru.values()):
            try:
                ws_root = os.path.abspath(rt.workspace_path)
            except Exception:
                continue
            if abs_path == ws_root or abs_path.startswith(ws_root + os.sep):
                return rt.drain_errors()
        return []

    async def restart(self, workspace_id: str, workspace_path: Optional[str] = None) -> Optional[AppRuntime]:
        rt = self.runtimes.get(workspace_id) or self._idle_lru.get(workspace_id)
        if rt is None:
            return None
        if workspace_path:
            rt.workspace_path = workspace_path
        await rt.restart()
        return rt

    async def stop_all(self) -> int:
        """Terminate every active + idle workspace subprocess. Called on
        FastAPI lifespan shutdown AND from Electron's pre-quit POST. Without
        this, each `bash run.sh` (and its vite/uvicorn descendants) reparents
        to PID 1 when the main backend dies, leaving ghost listeners on the
        persisted FRONTEND_PORT/BACKEND_PORT that block the NEXT OpenSwarm
        launch's app reload. Wakes any SIGSTOP'd idle entries before reaping
        so they can run their own shutdown. Parallel via gather; with the
        per-runtime 3s SIGTERM grace, worst case is one ~3s wait rather than
        N*3s. Idempotent; safe to invoke from multiple shutdown paths."""
        async with self._lock:
            victims: list[AppRuntime] = []
            for rt in list(self.runtimes.values()):
                victims.append(rt)
            for rt in list(self._idle_lru.values()):
                _resume_process_tree(rt.process)
                victims.append(rt)
            self.runtimes.clear()
            self._idle_lru.clear()
            self._attached.clear()
        if not victims:
            return 0
        await asyncio.gather(
            *(rt.stop() for rt in victims),
            return_exceptions=True,
        )
        return len(victims)


manager = AppRuntimeManager()
