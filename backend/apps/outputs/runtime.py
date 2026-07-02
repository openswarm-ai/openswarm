"""Per-workspace persistent backend.py runtime; one AppRuntime per workspace, refcounted by manager singleton."""

import asyncio
import logging
import os
import shutil
import sys
from collections import deque, OrderedDict
from dataclasses import dataclass
from typing import Callable, Optional


def p_resolve_bash() -> str:
    # Windows: Python's subprocess uses Windows-style PATH resolution and doesn't follow Git Bash's Unix-style entries like /mingw64/bin/..., so a bare "bash" call hits [WinError 2]. shutil.which goes through Windows PATHEXT lookup; fall back to the conventional Git for Windows install path so users without bash in their Windows PATH still work. POSIX: just return "bash" since the kernel finds it via PATH like any other exec.
    found = shutil.which("bash")
    if found:
        return found
    if sys.platform == "win32":
        for candidate in (
            r"C:\Program Files\Git\bin\bash.exe",
            r"C:\Program Files\Git\usr\bin\bash.exe",
            r"C:\Program Files (x86)\Git\bin\bash.exe",
        ):
            if os.path.exists(candidate):
                return candidate
    return "bash"

from backend.apps.outputs.runtime_proc import (
    ERROR_PATTERNS,
    FRONTEND_BIND_POLL_INTERVAL,
    FRONTEND_BIND_TIMEOUT_SECONDS,
    LOG_BUFFER_LINES,
    MAX_IDLE_RUNTIMES,
    RECENT_ERRORS_MAX,
    TERMINATE_GRACE_SECONDS,
    background_priority_kwargs,
    find_free_port,
    is_new_mode,
    is_port_free,
    kill_descendant_tree,
    read_env_value,
    resume_process_tree,
    suspend_process_tree,
    write_env_value,
)

logger = logging.getLogger(__name__)

# Module-level lock so only ONE vite optimizeDeps runs at a time; must be acquired before manager.p_lock to avoid deadlock with manager.attach.
p_vite_boot_lock = asyncio.Lock()

# How often the manager stats each attached workspace for a restart sentinel; one stat/sec/runtime is noise.
RESTART_SENTINEL_POLL_SECONDS = 1.0

# The agent-facing restart handshake: the workspace's restart.sh touches this and the manager restarts the runtime, so agents never need an API token to bounce their own app.
RESTART_SENTINEL_NAME = "restart-requested"


@dataclass
class LogLine:
    stream: str  # "stdout" | "stderr" | "runtime" (internal) | "frontend[-warn|-error]" (webview console via the console-log beacon)
    text: str


# Byte cap for the on-disk terminal tee; past this we rewrite the file from the ring buffer so an HMR-spammy session can't grow it unbounded.
TERMINAL_LOG_MAX_BYTES = 4 * 1024 * 1024

# Human/agent-facing prefixes for the terminal.log tee; mirrors the Terminal pane's labels so skill docs describe both with one vocabulary.
TERMINAL_LOG_PREFIXES = {
    "stdout": "[BACKEND]",
    "stderr": "[BACKEND:stderr]",
    "runtime": "[RUNTIME]",
    "frontend": "[FRONTEND]",
    "frontend-warn": "[FRONTEND:warn]",
    "frontend-error": "[FRONTEND:error]",
}


LogSubscriber = Callable[[LogLine], None]


def runtime_key(workspace_id: str, instance: int) -> str:
    """Registry key for a workspace instance. Instance 1 keeps the bare workspace_id so every existing get()/attach() caller keeps addressing the primary."""
    return workspace_id if instance <= 1 else f"{workspace_id}#{instance}"


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

    def __init__(self, workspace_id: str, workspace_path: str, instance: int = 1):
        self.workspace_id = workspace_id
        self.workspace_path = workspace_path
        # Instance 1 is the primary (uses the .env-pinned ports); >1 are extra dashboard cards of the same app, fully independent processes on fresh ports that must never rewrite the shared .env.
        self.instance = max(1, instance)
        # Old-mode: `port` is the backend.py port. New-mode: `port` is the workspace's optional FastAPI backend (only set if BACKEND_PORT!=NONE) and `frontend_port` is the Vite dev server port. Both Nones until start() decides what's there.
        self.port: Optional[int] = None
        self.frontend_port: Optional[int] = None
        # New-mode only: flips True once something is actually listening on frontend_port (we kick off a background poll task in p_start_new_mode). frontend_url returns null until this flips, so the preview pane doesn't try to navigate to an unbound port and show a "Site can't be reached" error mid-npm-install.
        self.p_frontend_ready: bool = False
        # True while the process tree is SIGSTOP'd in the idle pool. A frozen vite still holds its port but can't answer it, so frontend_url must stay null while suspended (else the webview loads a dead port = the ERR_FAILED on fast app-switching).
        self.p_suspended: bool = False
        self.process: Optional[asyncio.subprocess.Process] = None
        self.log_buffer: deque[LogLine] = deque(maxlen=LOG_BUFFER_LINES)
        # On-disk tee of the ring buffer so the App Builder agent can inspect terminal output itself (Read/grep); reset on every start(). Secondary instances get a suffixed file so they don't clobber the primary's.
        log_name = "terminal.log" if self.instance <= 1 else f"terminal-{self.instance}.log"
        self.p_terminal_log_path = os.path.join(workspace_path, ".openswarm", log_name)
        self.p_terminal_log_bytes = 0
        self.p_subscribers: set[LogSubscriber] = set()
        # Recent build/runtime errors scraped from stderr; drained by the agent's post-tool hook after Write/Edit so the agent sees vite/babel/uvicorn errors in its next turn and can self-fix instead of leaving the user with a red iframe overlay.
        self.recent_errors: deque[str] = deque(maxlen=RECENT_ERRORS_MAX)
        self.render_state: Optional[str] = None
        self.render_error_text: str = ""
        self.p_stdout_task: Optional[asyncio.Task] = None
        self.p_stderr_task: Optional[asyncio.Task] = None
        self.p_wait_task: Optional[asyncio.Task] = None
        self.p_frontend_ready_task: Optional[asyncio.Task] = None
        self.p_lock = asyncio.Lock()

    def drain_errors(self) -> list[str]:
        """Pop and return all accumulated error lines. Used by the
        agent-manager's post-tool hook to surface build errors back
        into the agent's context immediately after a file write."""
        out = list(self.recent_errors)
        self.recent_errors.clear()
        return out

    def set_render_ok(self) -> None:
        self.render_state = "ok"
        self.render_error_text = ""

    def set_render_error(self, text: str) -> None:
        self.render_state = "error"
        self.render_error_text = (text or "").strip()

    def reset_render_state(self) -> None:
        self.render_state = None
        self.render_error_text = ""

    @property
    def running(self) -> bool:
        return self.process is not None and self.process.returncode is None

    @property
    def has_backend_file(self) -> bool:
        return os.path.exists(os.path.join(self.workspace_path, "backend.py"))

    @property
    def is_new_mode(self) -> bool:
        return is_new_mode(self.workspace_path)

    @property
    def frontend_url(self) -> Optional[str]:
        # Gated on `_frontend_ready` (set by the background bind-poll task in p_start_new_mode) so the preview pane only switches over once Vite is actually accepting connections. Without this, the editor flashes a "Site can't be reached" error while `npm install` is running. Also gated on `running`: a vite that crashed or got orphaned still has _frontend_ready=True, and handing the webview that dead port is the ERR_FAILED you see on reopen. No live process, no URL. And gated on `not _suspended`: a SIGSTOP'd idle runtime is "running" (returncode is None) but frozen, so its port won't answer.
        if self.frontend_port and self.p_frontend_ready and self.running and not self.p_suspended:
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
        `p_vite_boot_lock` (see comment at the lock declaration) so a
        burst of "create 3 apps in 5 seconds" doesn't trigger 3 parallel
        MUI pre-bundle runs each pegging a core.
        """
        async with self.p_lock:
            if self.running:
                return True

            self.p_reset_terminal_log()
            if self.is_new_mode:
                # Acquire the module-level boot lock BEFORE the spawn so only one new-mode workspace is mid-bundle at a time. The lock is released by the bind-poll task the moment vite emits "frontend ready" (or its 180s timeout fires), which is the moment the next workspace can start its own vite without competing for the same CPU. See `p_await_frontend_bind` for the release.
                await p_vite_boot_lock.acquire()
                try:
                    ok = await self.p_start_new_mode()
                    if not ok:
                        # Spawn failed before the bind-poll task was created; release synchronously so we don't wedge the next workspace.
                        p_vite_boot_lock.release()
                    return ok
                except Exception:
                    p_vite_boot_lock.release()
                    raise
            return await self.p_start_old_mode()

    async def p_start_new_mode(self) -> bool:
        env_path = os.path.join(self.workspace_path, ".env")
        fp_raw = read_env_value(env_path, "FRONTEND_PORT")
        bp_raw = read_env_value(env_path, "BACKEND_PORT")
        if self.instance > 1:
            # Secondary instance: fresh ports always (the primary owns the .env-pinned ones), and NEVER rewrite the shared .env. .env is read only to learn whether the app has a backend at all.
            self.frontend_port = find_free_port()
            self.port = find_free_port() if (bp_raw and bp_raw != "NONE") else None
        else:
            # FRONTEND_PORT is allocated by seed_workspace; should always be a number. If missing, fall back to a fresh allocation (rare edge case: workspace seeded by an older OpenSwarm).
            try:
                self.frontend_port = int(fp_raw) if fp_raw else find_free_port()
            except ValueError:
                self.frontend_port = find_free_port()
            # Port-collision safety net: if a ghost subprocess from a prior OpenSwarm run is still bound to the persisted port (force-quit, crash, OS killed the parent before stop_all could reap), Vite would EADDRINUSE silently. Re-probe and reallocate, then rewrite .env so the bash run.sh subprocess reads the new port.
            if self.frontend_port and not is_port_free(self.frontend_port):
                new_port = find_free_port()
                self.p_broadcast(LogLine(
                    "runtime",
                    f"[runtime] persisted FRONTEND_PORT {self.frontend_port} is in use; reallocating to {new_port}",
                ))
                self.frontend_port = new_port
                write_env_value(env_path, "FRONTEND_PORT", str(new_port))
            # BACKEND_PORT may be the literal string "NONE" (frontend-only app; the common case) or a number once `backend_init.sh` has run. Only populate self.port when there's a real backend.
            if bp_raw and bp_raw != "NONE":
                try:
                    self.port = int(bp_raw)
                except ValueError:
                    self.port = None
                # Same collision check for the backend port; a leaked uvicorn from a prior session would otherwise block the new spawn.
                if self.port and not is_port_free(self.port):
                    new_port = find_free_port()
                    self.p_broadcast(LogLine(
                        "runtime",
                        f"[runtime] persisted BACKEND_PORT {self.port} is in use; reallocating to {new_port}",
                    ))
                    self.port = new_port
                    write_env_value(env_path, "BACKEND_PORT", str(new_port))
            else:
                self.port = None

        env = self.p_spawn_env_base()
        if self.instance > 1:
            # run.sh applies these AFTER sourcing .env, so the secondary boots on its own ports. Older workspaces (pre-override run.sh) ignore them; their secondary instance EADDRINUSEs visibly in the Terminal instead of silently sharing the primary.
            env["OPENSWARM_FORCE_FRONTEND_PORT"] = str(self.frontend_port)
            if self.port:
                env["OPENSWARM_FORCE_BACKEND_PORT"] = str(self.port)
        # bash run.sh reads .env itself; we don't need to set FRONTEND_PORT / BACKEND_PORT here. We DO export the install paths as env vars (the more reliable read site for subshells). OPENSWARM_DEBUGGER_PATH is legacy-only: workspaces seeded before the PyPI swap have a run.sh that editable-installs the bundled debugger from it; new templates resolve `swarm-debug` from PyPI via pyproject.
        from backend.apps.outputs.view_builder_templates import (
            DEBUGGER_PATH,
            TEMPLATE_BACKEND_PATH,
        )
        env["OPENSWARM_DEBUGGER_PATH"] = DEBUGGER_PATH
        env["OPENSWARM_TEMPLATE_BACKEND_PATH"] = TEMPLATE_BACKEND_PATH

        cmd, spawn_cwd, launch_desc = self.p_resolve_launch(env)
        try:
            self.process = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=spawn_cwd,
                env=env,
                **background_priority_kwargs(),
            )
        except Exception as e:
            logger.exception("failed to start new-mode runtime for %s", self.workspace_id)
            self.p_broadcast(LogLine("runtime", f"[runtime] failed to start: {e}"))
            self.frontend_port = None
            self.port = None
            self.process = None
            return False
        backend_note = f" + backend on {self.port}" if self.port else ""
        self.p_broadcast(LogLine("runtime", f"[runtime] {launch_desc} started; frontend on {self.frontend_port}{backend_note} (pid {self.process.pid})"))
        self.p_stdout_task = asyncio.create_task(self.p_pipe_stream(self.process.stdout, "stdout"))
        self.p_stderr_task = asyncio.create_task(self.p_pipe_stream(self.process.stderr, "stderr"))
        self.p_wait_task = asyncio.create_task(self.p_await_exit())
        # Kick off the port-bind poller so frontend_url flips on once Vite is actually accepting connections.
        self.p_frontend_ready = False
        self.p_frontend_ready_task = asyncio.create_task(self.p_await_frontend_bind())
        return True

    def p_resolve_launch(self, env: dict) -> tuple[list[str], str, str]:
        """Pick the new-mode launch command.

        Default is `bash run.sh` at the workspace root, which handles both
        frontend-only and backend-enabled apps. On Windows we take a fast path
        for frontend-only apps (the common case): run vite directly through the
        bundled node, with no system `bash` at all. The packaged Windows build
        ships node but not bash, so a user without Git for Windows hit
        [WinError 2] on `bash run.sh` and the preview never started. We only
        take this path when vite is actually present (node_modules linked);
        otherwise fall back to bash so behavior is unchanged everywhere else.
        vite.config.ts reads FRONTEND_PORT / BACKEND_PORT from the environment."""
        if os.name == "nt" and self.port is None:
            node = env.get("OPENSWARM_NODE_PATH") or shutil.which("node")
            vite_bin = os.path.join(
                self.workspace_path, "frontend", "node_modules", "vite", "bin", "vite.js"
            )
            if node and os.path.exists(node) and os.path.exists(vite_bin):
                env["FRONTEND_PORT"] = str(self.frontend_port)
                env["BACKEND_PORT"] = "NONE"
                return (
                    [node, "node_modules/vite/bin/vite.js"],
                    os.path.join(self.workspace_path, "frontend"),
                    "vite (bundled node, no bash)",
                )
        return [p_resolve_bash(), "run.sh"], self.workspace_path, "bash run.sh"

    async def p_await_frontend_bind(self) -> None:
        """Poll `frontend_port` every FRONTEND_BIND_POLL_INTERVAL until
        something binds (Vite dev server) or we hit the timeout. Emits a
        `[runtime]` log line on success/failure so the Terminal pane
        shows the transition; flips `_frontend_ready` which the
        `frontend_url` property reads.

        Also responsible for releasing the module-level `p_vite_boot_lock`
       ; every exit path (success, process death, hard timeout) MUST
        release exactly once so the next queued workspace can start its
        own vite spawn. A try/finally on the lock guarantees that even
        an exception in the poll body doesn't strand the lock holding."""
        # Track whether we've already released so the cleanup at the end doesn't double-release if a success path beat it.
        lock_released = False

        def p_release_boot_lock() -> None:
            nonlocal lock_released
            if lock_released:
                return
            lock_released = True
            try:
                p_vite_boot_lock.release()
            except RuntimeError:
                # Lock already released (e.g. start() failure path released synchronously before spawning the poll task).
                pass

        try:
            if not self.frontend_port:
                return
            port = self.frontend_port
            deadline = asyncio.get_event_loop().time() + FRONTEND_BIND_TIMEOUT_SECONDS
            while asyncio.get_event_loop().time() < deadline:
                # Stop polling if the process died; pointless to keep checking a port nothing will bind.
                if self.process is None or self.process.returncode is not None:
                    return
                try:
                    # asyncio.open_connection is the non-blocking equivalent of socket.create_connection. 0.5s connect timeout to avoid hanging if the host's TCP stack is under load.
                    fut = asyncio.open_connection("127.0.0.1", port)
                    reader, writer = await asyncio.wait_for(fut, timeout=0.5)
                    writer.close()
                    try:
                        await writer.wait_closed()
                    except Exception:
                        pass
                    self.p_frontend_ready = True
                    self.p_broadcast(LogLine(
                        "runtime",
                        f"[runtime] frontend ready at http://127.0.0.1:{port}/",
                    ))
                    # Release the vite-boot mutex the INSTANT vite is ready; the next queued workspace can start its own bundle now even though we'll keep streaming logs for this one.
                    p_release_boot_lock()
                    return
                except (OSError, asyncio.TimeoutError):
                    pass
                await asyncio.sleep(FRONTEND_BIND_POLL_INTERVAL)
            # Timed out; keep the runtime up (Terminal might show useful errors) but surface why the preview never appeared.
            self.p_broadcast(LogLine(
                "runtime",
                f"[runtime] frontend did NOT bind on port {port} after "
                f"{FRONTEND_BIND_TIMEOUT_SECONDS}s; check the Terminal "
                f"for npm/vite errors.",
            ))
        finally:
            # Catches process-death return, timeout fall-through, and any exception in the poll body. _release_boot_lock is idempotent so this is safe even after the success path already released.
            p_release_boot_lock()

    async def p_start_old_mode(self) -> bool:
        if not self.has_backend_file:
            self.port = None
            return False
        self.port = find_free_port()
        env = self.p_spawn_env_base()
        env["PORT"] = str(self.port)
        env["BACKEND_PORT"] = str(self.port)  # alias; both common names work
        try:
            # -u forces unbuffered stdout/stderr so the Terminal pane sees lines in real time, not whenever Python decides to flush its block buffer.
            self.process = await asyncio.create_subprocess_exec(
                sys.executable, "-u", "backend.py",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=self.workspace_path,
                env=env,
                **background_priority_kwargs(),
            )
        except Exception as e:
            logger.exception("failed to start backend for %s", self.workspace_id)
            self.p_broadcast(LogLine("runtime", f"[runtime] failed to start: {e}"))
            self.port = None
            self.process = None
            return False
        self.p_broadcast(LogLine("runtime", f"[runtime] backend started on port {self.port} (pid {self.process.pid})"))
        self.p_stdout_task = asyncio.create_task(self.p_pipe_stream(self.process.stdout, "stdout"))
        self.p_stderr_task = asyncio.create_task(self.p_pipe_stream(self.process.stderr, "stderr"))
        self.p_wait_task = asyncio.create_task(self.p_await_exit())
        return True

    def p_spawn_env_base(self) -> dict[str, str]:
        """Inherited env minus the install token. Backend.py can hit our
        REST API back via its own creds if it really needs to, but it
        shouldn't inherit the host process's token by default."""
        env = {k: v for k, v in os.environ.items() if k != "OPENSWARM_AUTH_TOKEN"}
        # Hand the workspace's backend/run.sh the exact interpreter we're running on. In the packaged build that's the bundled standalone Python, so a fresh machine with no system `python3` still works; in dev it's whatever launched uvicorn. OPENSWARM_NODE_PATH already rides in via os.environ (set by the Electron shell) for run.sh's Node resolution.
        env["OPENSWARM_PYTHON"] = sys.executable
        # Force npm to skip dependency lifecycle scripts for every install run.sh triggers. An imported app's package.json is untrusted (it brings its own run.sh, so we can't gate the flag there); a malicious dep's postinstall would otherwise run arbitrary code on the host the moment its preview boots. Vite/esbuild get their platform binary via optionalDependencies, not a script, so this doesn't break the build.
        env["npm_config_ignore_scripts"] = "true"
        return env

    async def stop(self) -> None:
        async with self.p_lock:
            if not self.process or self.process.returncode is not None:
                # Still cancel the bind poller in case stop() races a never-launched runtime; defensive no-op otherwise.
                if self.p_frontend_ready_task and not self.p_frontend_ready_task.done():
                    self.p_frontend_ready_task.cancel()
                return
            try:
                # Walk the descendant tree first so vite/uvicorn grandchildren die before bash exits and orphans them to PID 1. The webapp template's run.sh only traps EXIT, not TERM, so a flat SIGTERM to bash kills bash silently and leaves vite alive.
                kill_descendant_tree(self.process.pid, "TERM")
                self.process.terminate()
                try:
                    await asyncio.wait_for(self.process.wait(), timeout=TERMINATE_GRACE_SECONDS)
                except asyncio.TimeoutError:
                    kill_descendant_tree(self.process.pid, "KILL")
                    self.process.kill()
                    await self.process.wait()
            except ProcessLookupError:
                pass
            # Cancel the bind poller so it stops scanning a port that's gone away, and reset the readiness flag.
            if self.p_frontend_ready_task and not self.p_frontend_ready_task.done():
                self.p_frontend_ready_task.cancel()
            self.p_frontend_ready = False

    async def restart(self) -> bool:
        await self.stop()
        return await self.start()

    def subscribe(self, cb: LogSubscriber) -> Callable[[], None]:
        """Register a log subscriber. Immediately replays the ring buffer
        so a Terminal pane that opens mid-session shows context. Returns
        an unsubscribe function."""
        self.p_subscribers.add(cb)
        for line in list(self.log_buffer):
            try:
                cb(line)
            except Exception:
                pass

        def p_unsub() -> None:
            self.p_subscribers.discard(cb)

        return p_unsub

    def p_broadcast(self, line: LogLine) -> None:
        self.log_buffer.append(line)
        self.p_append_terminal_log(line)
        # Snapshot subscribers; they can self-remove during dispatch.
        for cb in list(self.p_subscribers):
            try:
                cb(line)
            except Exception:
                pass

    def announce(self, text: str) -> None:
        """Emit a [runtime]-stream status line; the public door for the manager (p_broadcast is class-private)."""
        self.p_broadcast(LogLine("runtime", text))

    def record_frontend_log(self, level: str, text: str) -> None:
        """Fold a webview console line into the terminal stream (ring buffer, WS subscribers, terminal.log). Called by the console-log beacon endpoint."""
        stream = {"warn": "frontend-warn", "error": "frontend-error"}.get(level, "frontend")
        self.p_broadcast(LogLine(stream, text))

    def p_reset_terminal_log(self) -> None:
        try:
            os.makedirs(os.path.dirname(self.p_terminal_log_path), exist_ok=True)
            with open(self.p_terminal_log_path, "w", encoding="utf-8") as f:
                f.write("# App terminal output (backend stdout/stderr, runtime events, frontend console). Reset on every app start.\n")
            self.p_terminal_log_bytes = 0
        except Exception:
            logger.exception("terminal.log reset failed for %s", self.workspace_id)

    def p_append_terminal_log(self, line: LogLine) -> None:
        # Failures must never break the log pipeline; the file is a convenience tee.
        try:
            prefix = TERMINAL_LOG_PREFIXES.get(line.stream, f"[{line.stream}]")
            rendered = f"{prefix} {line.text}\n"
            if self.p_terminal_log_bytes > TERMINAL_LOG_MAX_BYTES:
                # Rewrite from the ring buffer so the file self-heals to the last LOG_BUFFER_LINES lines instead of growing unbounded.
                with open(self.p_terminal_log_path, "w", encoding="utf-8") as f:
                    for old in list(self.log_buffer):
                        f.write(f"{TERMINAL_LOG_PREFIXES.get(old.stream, f'[{old.stream}]')} {old.text}\n")
                self.p_terminal_log_bytes = os.path.getsize(self.p_terminal_log_path)
                return
            with open(self.p_terminal_log_path, "a", encoding="utf-8") as f:
                f.write(rendered)
            self.p_terminal_log_bytes += len(rendered.encode("utf-8", errors="replace"))
        except Exception:
            pass

    def p_maybe_capture_error(self, text: str) -> None:
        if ERROR_PATTERNS.search(text):
            self.recent_errors.append(text.rstrip())

    def p_maybe_capture_render_beacon(self, text: str) -> None:
        if "[openswarm:app-ready]" in text:
            self.set_render_ok()
        elif "[openswarm:app-error]" in text:
            idx = text.index("[openswarm:app-error]") + len("[openswarm:app-error]")
            self.set_render_error(text[idx:].strip())

    async def p_pipe_stream(self, stream: Optional[asyncio.StreamReader], name: str) -> None:
        if stream is None:
            return
        try:
            while True:
                raw = await stream.readline()
                if not raw:
                    break
                text = raw.decode(errors="replace").rstrip("\r\n")
                if text:
                    self.p_broadcast(LogLine(name, text))
                    if name == "stderr" or name == "stdout":
                        self.p_maybe_capture_error(text)
                        self.p_maybe_capture_render_beacon(text)
        except Exception:
            logger.exception("log pipe error (%s) for %s", name, self.workspace_id)

    async def p_await_exit(self) -> None:
        if not self.process:
            return
        rc = await self.process.wait()
        # Unclean death (vite crash, OOM, orphaned parent) must drop readiness; otherwise frontend_url keeps advertising a dead port and the preview navigates into ERR_FAILED. stop() already does this for clean stops.
        self.p_frontend_ready = False
        self.p_broadcast(LogLine("runtime", f"[runtime] backend exited with code {rc}"))


class AppRuntimeManager:
    """Per-process singleton tracking all live AppRuntime instances.

    Reference-counts attachments so we don't kill a backend when one
    Terminal closes while another is still subscribed. First attach
    spawns; final detach moves the runtime into an LRU idle pool
    instead of stopping it immediately; so re-clicking a recent App
    is instant. The oldest runtime gets reaped once the pool exceeds
    MAX_IDLE_RUNTIMES."""

    def __init__(self) -> None:
        # workspace_id → AppRuntime, currently has >=1 subscriber.
        self.runtimes: dict[str, AppRuntime] = {}
        self.p_attached: dict[str, int] = {}
        # workspace_id → AppRuntime with no subscribers but still alive. OrderedDict gives O(1) move_to_end + popitem(last=False) for LRU semantics.
        self.idle_lru: "OrderedDict[str, AppRuntime]" = OrderedDict()
        self.p_lock = asyncio.Lock()
        # Public: tests cancel it during teardown.
        self.restart_watch_task: Optional[asyncio.Task] = None

    def p_ensure_restart_watcher(self) -> None:
        """Lazy-start the sentinel watcher on first attach; __init__ runs at import time, before any event loop exists."""
        if self.restart_watch_task is None or self.restart_watch_task.done():
            self.restart_watch_task = asyncio.create_task(self.p_watch_restart_sentinels())

    async def p_watch_restart_sentinels(self) -> None:
        """The agent-side restart path: a workspace's restart.sh (or a bare `touch
        .openswarm/restart-requested`) asks the harness to bounce the app runtime,
        which the agent cannot do itself (no API token, and uvicorn runs without
        --reload). Consume the sentinel FIRST so restart.sh's wait loop unblocks,
        then restart every attached instance of that workspace."""
        while True:
            await asyncio.sleep(RESTART_SENTINEL_POLL_SECONDS)
            try:
                seen_paths: set[str] = set()
                for rt in list(self.runtimes.values()):
                    ws_path = rt.workspace_path
                    if ws_path in seen_paths or rt.p_suspended or not rt.running:
                        continue
                    sentinel = os.path.join(ws_path, ".openswarm", RESTART_SENTINEL_NAME)
                    if not os.path.exists(sentinel):
                        continue
                    seen_paths.add(ws_path)
                    try:
                        os.remove(sentinel)
                    except OSError:
                        continue
                    for peer in list(self.runtimes.values()):
                        if peer.workspace_path == ws_path and peer.running and not peer.p_suspended:
                            peer.announce("[runtime] restart requested from the workspace (restart.sh); restarting...")
                            asyncio.create_task(peer.restart())
            except Exception:
                logger.exception("restart-sentinel watcher tick failed")

    async def attach(self, workspace_id: str, workspace_path: str, instance: int = 1) -> AppRuntime:
        self.p_ensure_restart_watcher()
        key = runtime_key(workspace_id, instance)
        revived = False
        # Defined here so every code path below leaves it bound; the revive-idle branch used to skip the assignment, leaving the post-lock `if dead is not None:` check throwing UnboundLocalError.
        dead: Optional[AppRuntime] = None
        async with self.p_lock:
            rt = self.runtimes.get(key)
            if rt is None:
                # Maybe the runtime is sitting idle in the LRU; revive it without paying the spawn cost again.
                idle_rt = self.idle_lru.pop(key, None)
                if idle_rt is not None and idle_rt.running:
                    rt = idle_rt
                    rt.workspace_path = workspace_path
                    self.runtimes[key] = rt
                    revived = True
                    # SIGCONT the process tree if A2 had it paused while idle. Pair with the SIGSTOP in detach() below.
                    resume_process_tree(rt.process)
                    rt.p_suspended = False
                else:
                    if idle_rt is not None:
                        # Stale idle entry; process died while idling. Drop and spawn a fresh one below; old one gets stopped outside the lock.
                        dead = idle_rt
                    rt = AppRuntime(workspace_id, workspace_path, instance)
                    self.runtimes[key] = rt
            else:
                # Workspace paths shouldn't change for a given id, but if somehow they did (e.g. the user moved the workspace folder), trust the latest caller; they have the current truth.
                rt.workspace_path = workspace_path
            self.p_attached[key] = self.p_attached.get(key, 0) + 1
        if not revived and not rt.running:
            await rt.start()
        # Stop any dead idle runtime outside the lock to avoid blocking.
        if dead is not None:
            try:
                await dead.stop()
            except Exception:
                logger.exception("failed to reap dead idle runtime %s", key)
        return rt

    async def detach(self, workspace_id: str, instance: int = 1) -> None:
        key = runtime_key(workspace_id, instance)
        to_idle: Optional[AppRuntime] = None
        to_reap: list[AppRuntime] = []
        async with self.p_lock:
            count = self.p_attached.get(key, 0) - 1
            if count > 0:
                self.p_attached[key] = count
                return
            self.p_attached.pop(key, None)
            rt = self.runtimes.pop(key, None)
            if rt is None:
                return
            # If the process is already dead, no point keeping it around; just clean up. Otherwise move to the LRU AND SIGSTOP the process tree so it consumes 0% CPU while idle. The matching SIGCONT lives in attach() above.
            if not rt.running:
                to_reap.append(rt)
            else:
                self.idle_lru[key] = rt
                self.idle_lru.move_to_end(key)
                suspend_process_tree(rt.process)
                rt.p_suspended = True
                while len(self.idle_lru) > MAX_IDLE_RUNTIMES:
                    _, old_rt = self.idle_lru.popitem(last=False)
                    # Reaping a stopped process: SIGCONT first so the SIGTERM in stop() can be delivered cleanly (a SIGSTOP'd process can't run its own shutdown).
                    resume_process_tree(old_rt.process)
                    to_reap.append(old_rt)
            to_idle = rt if rt.running else None

        # Stop any reaped runtimes OUTSIDE the lock. stop() is async and can take up to TERMINATE_GRACE_SECONDS; holding the lock for it would block every other attach/detach.
        for old in to_reap:
            try:
                await old.stop()
            except Exception:
                logger.exception("failed to reap idle runtime %s", key)
        if to_idle is not None:
            logger.debug("workspace %s idled (LRU size now %d)", key, len(self.idle_lru))

    def get(self, workspace_id: str, instance: int = 1) -> Optional[AppRuntime]:
        key = runtime_key(workspace_id, instance)
        # Active subscribers see the live runtime; idle-pool members are also accessible so a status probe between detach and the next attach still works.
        rt = self.runtimes.get(key)
        if rt is not None:
            return rt
        return self.idle_lru.get(key)

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
        # Walk both active and idle runtimes; the user might have navigated away from the workspace mid-build, but the agent could still be editing files; the LRU keeps the runtime alive for ~3 idle slots. Aggregate across instances: with two cards of the same app open, either instance's build errors matter to the agent.
        drained: list[str] = []
        for rt in (*self.runtimes.values(), *self.idle_lru.values()):
            try:
                ws_root = os.path.abspath(rt.workspace_path)
            except Exception:
                continue
            if abs_path == ws_root or abs_path.startswith(ws_root + os.sep):
                drained.extend(rt.drain_errors())
        return drained

    def get_render_state_for_workspace(self, workspace_id: str) -> tuple[Optional[str], str]:
        rt = self.runtimes.get(workspace_id) or self.idle_lru.get(workspace_id)
        if rt is None:
            return None, ""
        return rt.render_state, rt.render_error_text

    def reset_render_state_for_workspace(self, workspace_id: str) -> None:
        rt = self.runtimes.get(workspace_id) or self.idle_lru.get(workspace_id)
        if rt is not None:
            rt.reset_render_state()

    async def restart(self, workspace_id: str, workspace_path: Optional[str] = None, instance: int = 1) -> Optional[AppRuntime]:
        key = runtime_key(workspace_id, instance)
        rt = self.runtimes.get(key) or self.idle_lru.get(key)
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
        async with self.p_lock:
            victims: list[AppRuntime] = []
            for rt in list(self.runtimes.values()):
                victims.append(rt)
            for rt in list(self.idle_lru.values()):
                resume_process_tree(rt.process)
                victims.append(rt)
            self.runtimes.clear()
            self.idle_lru.clear()
            self.p_attached.clear()
        if not victims:
            return 0
        await asyncio.gather(
            *(rt.stop() for rt in victims),
            return_exceptions=True,
        )
        return len(victims)


manager = AppRuntimeManager()
