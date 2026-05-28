"""OS/process/port primitives for the per-workspace runtime: signal-based
suspend/resume, descendant-tree kills, free-port allocation, and .env
read/write. No asyncio runtime state lives here; AppRuntime (runtime.py) owns
that and just calls into these."""

import logging
import os
import re
import signal
import socket
import subprocess
from typing import Optional

logger = logging.getLogger(__name__)

# SIGTERM grace; well-behaved servers shut down under a second so 3s is enough.
_TERMINATE_GRACE_SECONDS = 3

# 180s covers npm install (60-90s on typical hardware) plus the Vite bind.
_FRONTEND_BIND_TIMEOUT_SECONDS = 180
# 80ms probe: dropping from 500ms was pure user-visible preview latency win; cheap on localhost.
_FRONTEND_BIND_POLL_INTERVAL = 0.08

# 2000 lines per runtime; lets a Terminal tab opened mid-session replay context. ~few hundred KB at worst.
_LOG_BUFFER_LINES = 2000

# Idle runtimes kept in LRU; trades memory for instant switch-back, beyond 1 because typical users ping-pong 2-3 apps.
_MAX_IDLE_RUNTIMES = 3

# Cap on recent error lines the agent gets; 50 is enough for babel error + stack + a few warnings.
_RECENT_ERRORS_MAX = 50

# Narrow regex for build errors (vite, babel, tsc, uvicorn); keeps routine logs out of agent context.
_ERROR_PATTERNS = re.compile(
    r"(?:"
    r"\[plugin:[^\]]+\]|"      # vite plugin errors
    r"SyntaxError|"            # node / babel
    r"Unexpected token|"       # babel / tsc parser
    r"\berror TS\d+|"          # tsc diagnostics
    r"ERROR\s+in\s|"           # webpack-style
    r"Traceback \(most recent call last\)|"  # python
    r"ModuleNotFoundError|"
    r"ImportError|"
    r"AttributeError:|"
    r"Failed to compile|"
    r"Cannot find module|"
    r"Cannot resolve"
    r")"
)


def _suspend_process_tree(proc) -> None:
    """Send SIGSTOP to a workspace's subprocess so it consumes 0% CPU
    while sitting in the LRU idle pool. The signal is delivered to the
    PROCESS GROUP (negative PID) when the child is a session leader,
    so vite + uvicorn + their npm/python subchildren all pause together.

    No-op on Windows (SIGSTOP has no equivalent; the `OpenProcessToken` +
    `NtSuspendProcess` route works but isn't worth the win32 surface
    here; idle Windows runtimes just stay running, which is the current
    behavior). Failures here are swallowed; if the process already died
    a stop signal is meaningless."""
    if proc is None or os.name == "nt":
        return
    try:
        if proc.returncode is not None:
            return
        os.kill(proc.pid, signal.SIGSTOP)
    except (ProcessLookupError, PermissionError, OSError):
        # Already-dead or out-of-permission; both safe to ignore.
        pass


def _resume_process_tree(proc) -> None:
    """SIGCONT a previously-suspended workspace process. Pair with
    _suspend_process_tree. Microsecond cost; idempotent if the process
    was never paused."""
    if proc is None or os.name == "nt":
        return
    try:
        if proc.returncode is not None:
            return
        os.kill(proc.pid, signal.SIGCONT)
    except (ProcessLookupError, PermissionError, OSError):
        pass


def _background_priority_kwargs() -> dict:
    """Return the kwargs that lower the spawned subprocess's OS priority
    to a "background" level. On POSIX this is `preexec_fn=os.nice(10)`,
    which sets the child's nice to +10 BEFORE exec (so the renice covers
    the entire bash → vite + uvicorn process tree). On Windows it's
    `creationflags=BELOW_NORMAL_PRIORITY_CLASS`. The OS scheduler then
    yields workspace cycles to whichever agent or browser tab is in the
    user's foreground, so an in-background app build doesn't starve a
    live chat session.

    We intentionally do NOT pass `start_new_session=True` here even
    though it would defend against an errant `kill 0` inside the
    workspace propagating into the OpenSwarm group: doing so also
    detaches the workspace from the terminal's foreground process
    group, so a user Ctrl+C only reaches OpenSwarm itself and the
    cleanup path has to chase every workspace by hand. If that path
    is even slightly slow or gets interrupted by a second Ctrl+C, the
    workspace's uvicorn / vite leaks past shutdown and the next
    `bash run.sh` hits Errno 48 on port 8324. The `kill 0` propagation
    is fixed at its source in the workspace template's run.sh
    (uses `kill_tree` on tracked PIDs, never `kill 0`)."""
    if os.name == "nt":
        # subprocess.BELOW_NORMAL_PRIORITY_CLASS == 0x4000
        return {"creationflags": subprocess.BELOW_NORMAL_PRIORITY_CLASS}
    return {"preexec_fn": lambda: os.nice(10)}


def _find_free_port() -> int:
    """Ask the kernel for an unused localhost port. There's a tiny race
    between this socket closing and the backend re-binding, but we hand
    each port to exactly one runtime so no caller competes for it, and
    the kernel won't immediately recycle a freshly-closed port anyway."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _kill_descendant_tree(pid: int, sig_name: str = "TERM") -> None:
    """Recursively signal every descendant of `pid`, leaves-first. The
    webapp template's run.sh installs `trap cleanup EXIT` (no TERM), so a
    plain SIGTERM to the bash wrapper exits bash silently and leaves
    vite/uvicorn grandchildren reparented to PID 1, squatting on the
    workspace's ports. Walking the tree ourselves bypasses the template's
    signal-handling habits entirely. POSIX uses `pgrep -P` to enumerate
    direct children; Windows is covered by `taskkill /T /F` (job-object
    walk). All failures are swallowed; missing PIDs mean the process
    already exited, which is the desired state anyway."""
    if os.name == "nt":
        try:
            subprocess.run(
                ["taskkill", "/PID", str(pid), "/T", "/F"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=5,
            )
        except Exception:
            pass
        return
    try:
        out = subprocess.run(
            ["pgrep", "-P", str(pid)],
            capture_output=True,
            text=True,
            timeout=2,
        )
        children = [int(p) for p in out.stdout.split() if p.strip().isdigit()]
    except Exception:
        children = []
    for child in children:
        _kill_descendant_tree(child, sig_name)
    sig = getattr(signal, f"SIG{sig_name}", signal.SIGTERM)
    for child in children:
        try:
            os.kill(child, sig)
        except (ProcessLookupError, PermissionError, OSError):
            pass


def _is_port_free(port: int) -> bool:
    """True if nothing currently holds a TCP listener on 127.0.0.1:port.
    Cheap kernel-probe; resolves on bind success. Used as the cross-session
    safety net: if a prior OpenSwarm run left a ghost subprocess holding
    the .env-persisted FRONTEND_PORT, we detect it here and reallocate
    rather than handing run.sh a port that will EADDRINUSE."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.bind(("127.0.0.1", port))
        return True
    except OSError:
        return False


def _write_env_value(env_path: str, key: str, value: str) -> None:
    """Update KEY=VALUE in an existing `.env`, preserving every other
    line. Creates the file if missing. Used when a persisted port collides
    with a ghost from a prior session and we have to reallocate before
    spawning run.sh."""
    lines: list[str] = []
    found = False
    if os.path.exists(env_path):
        try:
            with open(env_path, encoding="utf-8") as f:
                lines = f.readlines()
        except Exception:
            lines = []
    for i, raw in enumerate(lines):
        stripped = raw.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        k = stripped.split("=", 1)[0].strip()
        if k == key:
            lines[i] = f"{key}={value}\n"
            found = True
            break
    if not found:
        if lines and not lines[-1].endswith("\n"):
            lines[-1] = lines[-1] + "\n"
        lines.append(f"{key}={value}\n")
    try:
        with open(env_path, "w", encoding="utf-8") as f:
            f.writelines(lines)
    except Exception:
        logger.exception("failed writing %s=%s to %s", key, value, env_path)


def _is_new_mode(workspace_path: str) -> bool:
    """A workspace is "new-mode" (webapp-template scaffold) if it has a
    `run.sh` at its root. Old-mode workspaces are flat `index.html`-only
    apps that pre-date the template swap; they're served by OpenSwarm's
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
                # Strip an inline `# comment`. Naive; bash semantics are
                # more permissive, but values we write don't contain `#`.
                if "#" in v:
                    v = v.split("#", 1)[0].rstrip()
                if (v.startswith('"') and v.endswith('"')) or (v.startswith("'") and v.endswith("'")):
                    v = v[1:-1]
                return v
    except Exception:
        logger.exception("failed reading %s from %s", key, env_path)
    return None
