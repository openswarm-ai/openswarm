"""9Router subprocess lifecycle: constants, path resolution, start/stop, stats.

This is the single owner of the 9Router process handle and its is_running
cache. Nothing else in the package spawns or kills the subprocess; the sync
and oauth modules only talk to the already-running server over HTTP.

9Router is a free AI subscription proxy that lets users connect their
Claude/ChatGPT/Gemini subscriptions to OpenSwarm without API keys. It runs
silently in the background on port 20128 and exposes an OpenAI-compatible
API at localhost:20128/v1.
"""

import asyncio
import hashlib
import logging
import os
import secrets
import shutil
import socket
import subprocess
import tempfile
import time
from typing import Any

import httpx

logger = logging.getLogger(__name__)

NINE_ROUTER_PORT = 20128
NINE_ROUTER_URL = f"http://localhost:{NINE_ROUTER_PORT}"
NINE_ROUTER_API = f"{NINE_ROUTER_URL}/api"
NINE_ROUTER_V1 = f"{NINE_ROUTER_URL}/v1"

# Pinned 9router npm package version. Prod default stays 0.3.60; set OPENSWARM_ROUTER_VERSION to stage a bump in dev (keys the dev cache by version, so the override pulls a clean install) without shipping it. 0.4.x gates its internal /api/* routes behind auth (the old bump blocker): bare `POST /api/providers` / `/api/oauth/<prov>/device-code` now 401 instead of working. That auth is now PORTED here: see cli_auth_token() / cli_auth_headers() below, which compute the `x-9r-cli-token` 9Router checks and which every /api/* call in this package attaches. The header is empty on 0.3.60 (no machine-id file), so the old auth-free path is untouched. What the bump buys: cc/claude-opus-4-8 and cx/gpt-5.5 on the sub routes (gpt-5.5 404s on 0.3.60), a reworked WebSearch behind /api/v1/search, and 3 months of cross-provider translator robustness. REMAINING gate before flipping the prod default to 0.4.x: re-qualify cross-provider WebSearch. The original 0.3.60 pin reason was that 0.3.60-0.3.96 regressed it (a Codex/Gemini primary delegating WebSearch saw "claude-haiku-4-5-20251001 unavailable" or hallucinated output); 0.4.x reworked it but that's unverified here. Also confirmed on 0.4.80: it STILL emits `max_tokens` (not max_completion_tokens) on Anthropic->OpenAI, so our /api/openai-passthrough rename (core/openai_passthrough.py + sync_openai_api_key, routed via an `openai-compatible` node that honors `baseUrl`) STAYS necessary.
NINE_ROUTER_NPM_VERSION = os.environ.get("OPENSWARM_ROUTER_VERSION", "0.3.60")

# 9Router (our pinned 0.3.60) appends every request to ~/.9router/request-details.json and reloads the WHOLE file on each write; once it reaches tens of MB the router's node process OOM-aborts and takes the app down, even while idle (verified from crash dumps). Two cheap, pin-safe guards until the real fix (a 9Router bump past 0.4.66, which moved off this file): 1. rotate that log before we spawn 9Router when it gets large, so growth can't run away; 2. give node an explicit, generous heap ceiling for legitimate large multimodal bodies. Neither touches routing, so WebSearch/WebFetch translation and the 0.3.60 pin are unaffected.
P_REQUEST_LOG_PATH = os.path.expanduser("~/.9router/request-details.json")
P_REQUEST_LOG_MAX_BYTES = 5 * 1024 * 1024
P_NODE_HEAP_MB = 4096


def p_rotate_request_log() -> None:
    """Rotate ~/.9router/request-details.json to a single .0 backup when it grows past the cap,
    BEFORE 9Router is spawned (never racing a live writer). 9Router recreates a fresh file, exactly
    like a clean install. The only consumer is the 'most recent 5' reasoning-token lookup, which
    already tolerates an empty/missing file, so no feature loses data it depends on."""
    try:
        if os.path.exists(P_REQUEST_LOG_PATH) and os.path.getsize(P_REQUEST_LOG_PATH) > P_REQUEST_LOG_MAX_BYTES:
            os.replace(P_REQUEST_LOG_PATH, P_REQUEST_LOG_PATH + ".0")
            logger.info(
                "9Router request log rotated (exceeded %d MB) to avoid the router OOM",
                P_REQUEST_LOG_MAX_BYTES // (1024 * 1024),
            )
    except Exception as e:
        logger.debug("9Router request-log rotation skipped: %s", e)


p_process: subprocess.Popen | None = None

# Serializes ensure_running() so a background auto-start and a concurrent dispatch-time ensure can't both spawn 9Router (double-bind on :20128). Lazily created so module import doesn't require a running event loop.
p_start_lock: "asyncio.Lock | None" = None

# Short TTL cache for positive is_running() results. The probe is a sync httpx.get that blocks the event loop, and under load (9Router busy streaming inference) it can exceed its 2s timeout and return False even though 9Router is fine. Caching a recent True result avoids those false negatives without masking a real crash for more than P_IS_RUNNING_TTL seconds. Negative results are NOT cached so startup detection in ensure_running() remains correct.
P_IS_RUNNING_TTL = 10.0
p_is_running_last_ok: float = 0.0


def is_running() -> bool:
    """Check if 9Router is running.

    Fast-fail when down. is_running() is called ~5x on the cold boot path (the
    settings key-sync sequence + ensure_running) BEFORE 9Router is up. The old
    body did a synchronous httpx.get to "localhost:20128"; on Windows a dead-port
    connect to "localhost" stalls multiple seconds (it tries ::1 first and the
    loopback refusal is slow), so those probes froze the asyncio event loop ~18s
    and dominated cold startup (faulthandler caught the loop stuck in
    socket.create_connection here). Fix: probe 127.0.0.1 with a 0.3s TCP timeout
    first; a down 9Router is detected in <~0.3s instead of ~7s. Only when the
    port is open do we do the HTTP confirm. 9Router binds 0.0.0.0 (the warm app
    reaches it via 127.0.0.1 today), so this changes timing, not reachability."""
    global p_is_running_last_ok
    now = time.monotonic()
    if now - p_is_running_last_ok < P_IS_RUNNING_TTL:
        return True
    try:
        with socket.create_connection(("127.0.0.1", NINE_ROUTER_PORT), timeout=0.3):
            pass
    except OSError:
        return False
    try:
        r = httpx.get(f"http://127.0.0.1:{NINE_ROUTER_PORT}/v1/models", timeout=2.0)
        if r.status_code == 200:
            p_is_running_last_ok = now
            return True
        return False
    except Exception:
        return False


def p_nine_router_data_dir() -> str:
    """Where 9Router persists machine-id + auth/cli-secret, the two files we
    hash into the /api/* auth token on 0.4.x. Mirrors 9Router's own default
    (DATA_DIR env, else ~/.9router on unix, %APPDATA%/9router on win) so we read
    the exact files it writes. We never relocate it: that would orphan a user's
    existing subscription connections."""
    env_dir = os.environ.get("DATA_DIR")
    if env_dir:
        return env_dir
    if os.name == "nt":
        base = os.environ.get("APPDATA") or os.path.join(
            os.path.expanduser("~"), "AppData", "Roaming"
        )
        return os.path.join(base, "9router")
    return os.path.join(os.path.expanduser("~"), ".9router")


p_cli_token_cache: str | None = None


def cli_auth_token() -> str | None:
    """The token 9Router 0.4.x checks in `x-9r-cli-token` on /api/* calls:
    sha256(machineId + "9r-cli-auth" + cliSecret)[:16]. machine-id is written
    at 9Router boot, cli-secret only lazily on its first self-call, so we create
    cli-secret ourselves (atomic O_EXCL, 0600, identical to 9Router's getter)
    when missing so connect/sync can auth before that self-call. Returns None on
    0.3.60 (no machine-id) or when 9Router isn't up, so the caller sends no
    header and the old auth-free path is untouched. Never raises."""
    global p_cli_token_cache
    if p_cli_token_cache:
        return p_cli_token_cache
    if not is_running():
        return None
    try:
        data_dir = p_nine_router_data_dir()
        try:
            with open(os.path.join(data_dir, "machine-id"), encoding="utf-8") as f:
                machine_id = f.read().strip()
        except OSError:
            return None  # 0.3.60 layout, or 9Router hasn't written it yet
        if not machine_id:
            return None
        secret_path = os.path.join(data_dir, "auth", "cli-secret")
        try:
            with open(secret_path, encoding="utf-8") as f:
                cli_secret = f.read().strip()
        except OSError:
            cli_secret = ""
        if not cli_secret:
            cli_secret = secrets.token_hex(32)
            try:
                os.makedirs(os.path.dirname(secret_path), exist_ok=True)
                # O_EXCL: if 9Router won the race and wrote first, read its value.
                fd = os.open(secret_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                with os.fdopen(fd, "w") as f:
                    f.write(cli_secret)
            except FileExistsError:
                with open(secret_path, encoding="utf-8") as f:
                    cli_secret = f.read().strip()
        if not cli_secret:
            return None
        tok = hashlib.sha256(
            (machine_id + "9r-cli-auth" + cli_secret).encode("utf-8")
        ).hexdigest()[:16]
        p_cli_token_cache = tok
        return tok
    except Exception:
        return None


def cli_auth_headers() -> dict[str, str]:
    """`x-9r-cli-token` header for 9Router 0.4.x /api/* calls; empty dict on
    0.3.60 (no token), where the old auth-free endpoints still answer."""
    tok = cli_auth_token()
    return {"x-9r-cli-token": tok} if tok else {}


def p_find_9router_dir() -> str | None:
    """Locate the bundled 9Router directory (works in both dev and packaged mode)."""
    p_is_packaged = os.environ.get("OPENSWARM_PACKAGED") == "1"

    if p_is_packaged:
        import sys
        p_resources = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
        p_candidate = os.path.join(p_resources, "router")
        if os.path.isdir(p_candidate):
            return p_candidate
    else:
        p_backend_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        p_project_root = os.path.dirname(p_backend_dir)
        p_candidate = os.path.join(p_project_root, "router")
        if os.path.isdir(p_candidate):
            return p_candidate

    return None


def p_gpt5_patch_path() -> str | None:
    """Absolute path to backend/apps/agents/9router_gpt5_patch.js, used as
    `node --require <path>` when spawning 9router.

    The patch intercepts outbound HTTPS to api.openai.com and renames
    `max_tokens` → `max_completion_tokens` for GPT-5 models. Without it,
    every gpt-5* own-key session 400's because OpenAI rejects the legacy
    field name and 9router (every version including 0.4.20) emits it.

    Returns None if the file is missing; `subprocess.Popen` would fail
    on `node --require <missing-path>`, so the caller drops the flag and
    spawns 9router unpatched (failure mode = identical to pre-patch
    baseline; GPT-5 still 400's but everything else works).

    Path resolution: walks up from this module to backend/apps/agents/.
    Works identically in dev (`bash run.sh`) and packaged builds (Mac dmg
    + Windows exe both ship this file under Resources/backend/...).
    """
    apps_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    candidate = os.path.join(apps_dir, "agents", "9router_gpt5_patch.js")
    return candidate if os.path.exists(candidate) else None


def p_find_node() -> str | None:
    """Find a Node.js binary (works in both dev and packaged mode).

    Priority order:
      1. OPENSWARM_NODE_PATH; set by electron/main.js when a real Node
         binary is bundled in extraResources. Always preferred on user
         machines because it (a) avoids the bouncing "exec" Dock icon
         that ELECTRON_RUN_AS_NODE produces on fresh Macs and (b) starts
         in ~50ms vs Electron-as-Node's 5, 15s cold-start, shrinking the
         splash window the user stares at.
      2. System `node` on PATH; dev convenience.
      3. ELECTRON_RUN_AS_NODE fallback; last resort. Only hits this on
         packaged builds that for some reason shipped without the bundled
         node payload.
    """
    bundled = os.environ.get("OPENSWARM_NODE_PATH")
    if bundled and os.path.exists(bundled):
        return bundled

    node = shutil.which("node")
    if node:
        return node

    electron_path = os.environ.get("OPENSWARM_ELECTRON_PATH")
    if electron_path and os.path.exists(electron_path):
        return electron_path

    return None


def p_dev_router_cache_dir() -> str:
    """Cache dir for the npm 9router package used in dev mode.

    Pinned per version so bumping NINE_ROUTER_NPM_VERSION triggers a fresh
    install instead of reusing a stale cache.
    """
    base = os.environ.get("XDG_CACHE_HOME") or os.path.join(
        os.path.expanduser("~"), ".cache"
    )
    return os.path.join(base, "openswarm-router", NINE_ROUTER_NPM_VERSION)


def p_ensure_router_cached() -> str | None:
    """Ensure the npm 9router package is installed in the dev cache.

    Returns the absolute path to `app/server.js` on success, or None if
    npm isn't available or the install fails. Idempotent; returns
    immediately when the server file already exists.

    Running `node app/server.js` directly (instead of `npx 9router`)
    skips the CLI wrapper, which means no systray menu-bar icon,
    no update-check spinner, and no accidental-quit foot-gun when a
    non-developer right-clicks the "9" tray icon and picks Quit.
    """
    cache_dir = p_dev_router_cache_dir()
    server_js = os.path.join(cache_dir, "node_modules", "9router", "app", "server.js")
    if os.path.exists(server_js):
        return server_js

    npm = shutil.which("npm")
    if not npm:
        logger.warning("npm not found; install Node.js to auto-start 9Router in dev.")
        return None

    try:
        os.makedirs(cache_dir, exist_ok=True)
        pkg_json = os.path.join(cache_dir, "package.json")
        if not os.path.exists(pkg_json):
            with open(pkg_json, "w") as f:
                f.write('{"name":"_openswarm_router_cache","version":"0.0.0","private":true}\n')

        logger.info(
            "Installing 9router@%s into %s (one-time, ~30s)...",
            NINE_ROUTER_NPM_VERSION, cache_dir,
        )
        # Note: we do NOT pass --ignore-scripts. The package's postinstall rebuilds better-sqlite3 for the host platform; skipping it leaves the server unable to load its native addon.
        subprocess.run(
            [npm, "install", f"9router@{NINE_ROUTER_NPM_VERSION}",
             "--no-save", "--no-audit", "--no-fund", "--silent"],
            cwd=cache_dir,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=300,
            check=False,
        )
    except Exception as e:
        logger.warning("Failed to install 9router into %s: %s", cache_dir, e)
        return None

    return server_js if os.path.exists(server_js) else None


def p_read_capture_tail(path: str, limit: int = 6000) -> str:
    """Tail of the 9Router start-capture file, where the real spawn error lands.
    Best-effort; empty string on any hiccup so telemetry never breaks boot."""
    try:
        with open(path, "rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(max(0, size - limit))
            return f.read().decode("utf-8", "replace")
    except OSError:
        return ""


def p_report_start_failure(reason: str, *, detail: str = "", **fields: Any) -> None:
    """9Router didn't come up. Log it and ship a scrubbed diagnostic so a user's
    'every model exits 1' is finally explained from our side instead of a silent
    warning. The stderr tail can echo an own_key, so it rides the same scrub as
    every other telemetry string. Never raises."""
    logger.warning("9Router start failed (%s)", reason)
    try:
        from backend.apps.agents.core.error_classify import redact_for_telemetry
        from backend.apps.service.client import submit_diagnostic
        payload: dict[str, Any] = {
            "kind": "9router_start_failed",
            "reason": reason,
            "packaged": os.environ.get("OPENSWARM_PACKAGED") == "1",
            **fields,
        }
        if detail:
            payload["stderr_tail"] = redact_for_telemetry(detail)
        submit_diagnostic(payload)
    except Exception:
        logger.debug("9router start-failure diagnostic submit failed", exc_info=True)


async def ensure_running():
    """Start 9Router if not already running. Serialized so concurrent callers
    (the background auto-start + a dispatch-time ensure) can't double-spawn."""
    global p_start_lock
    if p_start_lock is None:
        p_start_lock = asyncio.Lock()
    async with p_start_lock:
        await p_ensure_running_impl()
    # Arm both healers the moment the router becomes a live dependency; users who never route through it never spawn them.
    if is_running():
        start_watchdog()
        start_death_watcher()


def has_persisted_connections() -> bool:
    """True when 9Router's on-disk db shows an active provider connection. Readable while the
    router is DOWN, so revival logic can tell a sub-only user (revive!) from a zero-config one
    (don't boot a router that has nothing to route). Fail-closed on any read problem."""
    try:
        import json as p_json
        with open(os.path.join(p_nine_router_data_dir(), "db.json"), encoding="utf-8") as f:
            db = p_json.load(f)
        return any(
            isinstance(c, dict) and c.get("isActive")
            for c in (db.get("providerConnections") or [])
        )
    except Exception:
        return False


# 20s pulse while healthy; after 3 straight failed revives (no node, broken install) back way off so a dead-end setup logs once per 5min instead of crash-looping.
WATCHDOG_INTERVAL_SECONDS = 20.0
WATCHDOG_BACKOFF_SECONDS = 300.0
watchdog_task: "asyncio.Task | None" = None


async def watchdog_loop() -> None:
    """Backstop healer for routers we DIDN'T spawn (adopted port-holders have no handle for the
    death-watcher). Two-strike confirmation before reviving: the sync is_running probe can
    false-negative while a busy router streams, and acting on one bad probe would rotate a LIVE
    router's request log and burn a duplicate spawn attempt."""
    failures = 0
    p_loop = asyncio.get_running_loop()
    while True:
        await asyncio.sleep(WATCHDOG_BACKOFF_SECONDS if failures >= 3 else WATCHDOG_INTERVAL_SECONDS)
        try:
            # is_running()'s HTTP confirm is SYNC and can stall 2s while the router is busy streaming; a periodic pulse must never block the event loop, so probe from a thread.
            if await p_loop.run_in_executor(None, is_running):
                failures = 0
                continue
            await asyncio.sleep(2)
            if await p_loop.run_in_executor(None, is_running):
                failures = 0
                continue
            logger.warning("9Router watchdog: router is down (confirmed twice); reviving")
            await ensure_running()
            if is_running():
                failures = 0
                logger.info("9Router watchdog: revived")
            else:
                failures += 1
        except asyncio.CancelledError:
            raise
        except Exception:
            failures += 1
            logger.exception("9Router watchdog iteration failed")


# Instant healer for the process WE spawned: its exit wakes us the moment it happens (no polling,
# no false positives), so total heal time = just the respawn. Crash-loop guard: 3 deaths inside
# 60s defers to the backed-off watchdog instead of hot-spinning a broken install.
p_death_watcher_task: "asyncio.Task | None" = None
recent_death_monos: "list[float]" = []


async def death_watch(proc_handle: "subprocess.Popen[Any]") -> None:
    global p_is_running_last_ok
    loop = asyncio.get_running_loop()
    try:
        await loop.run_in_executor(None, proc_handle.wait)
    except asyncio.CancelledError:
        raise
    except Exception:
        return
    # stop() nulls p_process before this continuation can run (it blocks the loop through wait), so a deliberate quit or a superseded handle never triggers a revive.
    if proc_handle is not p_process:
        return
    now = time.monotonic()
    recent_death_monos.append(now)
    del recent_death_monos[:-3]
    if len(recent_death_monos) == 3 and now - recent_death_monos[0] < 60:
        logger.warning("9Router died 3x in 60s; leaving revival to the backed-off watchdog")
        return
    logger.warning("9Router process died; instant revive")
    p_is_running_last_ok = 0.0
    await ensure_running()


def start_death_watcher() -> None:
    """Idempotent per spawned handle; no-op for adopted routers (no handle to wait on)."""
    global p_death_watcher_task
    if p_process is None or p_process.poll() is not None:
        return
    if p_death_watcher_task is not None and not p_death_watcher_task.done():
        return
    try:
        p_death_watcher_task = asyncio.get_running_loop().create_task(death_watch(p_process))
    except RuntimeError:
        logger.warning("9Router death-watcher: no running loop; not armed")


def start_watchdog() -> None:
    """Idempotent; armed by ensure_running() on success, cancelled by stop()."""
    global watchdog_task
    if watchdog_task is not None and not watchdog_task.done():
        return
    try:
        watchdog_task = asyncio.get_running_loop().create_task(watchdog_loop())
    except RuntimeError:
        logger.warning("9Router watchdog: no running loop; not armed")


async def p_ensure_running_impl():
    """Start 9Router if not already running."""
    global p_process, p_is_running_last_ok
    p_is_packaged = os.environ.get("OPENSWARM_PACKAGED") == "1"

    if is_running():
        # In dev mode, kill stale standalone servers (from previous builds) so we can start `next dev` which always uses latest source code
        if not p_is_packaged:
            # But never kill the instance WE already started: a second ensure call (another sub-app's lifespan races settings') would pkill our fresh next-server, leaving a dead window the boot key-sync fails into, so the cp-openai node never registers and gpt-5.* own-key dies.
            if p_process is not None and p_process.poll() is None:
                logger.info("9Router already running (ours) on port %d", NINE_ROUTER_PORT)
                return
            import subprocess as p_sp
            try:
                result = p_sp.run(
                    ["pgrep", "-f", "next-server"],
                    capture_output=True, text=True, timeout=3,
                )
                if result.stdout.strip():
                    logger.info("Dev mode: killing stale standalone 9Router to use next dev instead")
                    p_sp.run(["pkill", "-f", "next-server"], timeout=5)
                    # The port is about to go dead; drop the positive-cache so the start-loop below actually re-probes instead of trusting the killed server's stale "ready".
                    p_is_running_last_ok = 0.0
                    await asyncio.sleep(2)
                else:
                    logger.info("9Router already running on port %d", NINE_ROUTER_PORT)
                    return
            except Exception:
                logger.info("9Router already running on port %d", NINE_ROUTER_PORT)
                return
        else:
            logger.info("9Router already running on port %d", NINE_ROUTER_PORT)
            return
    p_rotate_request_log()
    p_9router_dir = p_find_9router_dir()
    p_patch = p_gpt5_patch_path()

    if p_is_packaged:
        # Packaged: run the pre-built standalone server staged at <resources>/router/server.js by fetch-router at build time. We do NOT fall back to the dev npm path here, a user machine has no npm, so that only ever fails silently; every miss is reported instead.
        if not p_9router_dir:
            p_report_start_failure("router_not_bundled")
            return
        standalone_server = os.path.join(p_9router_dir, "server.js")
        if not os.path.exists(standalone_server):
            standalone_server = os.path.join(p_9router_dir, ".next", "standalone", "server.js")
        if not os.path.exists(standalone_server):
            p_report_start_failure("server_missing", router_dir_found=True)
            return
        node = p_find_node()
        if not node:
            p_report_start_failure("node_not_found", router_dir_found=True, server_found=True)
            return
        logger.info("Starting 9Router (production) on port %d...", NINE_ROUTER_PORT)
        cmd = [node, f"--max-old-space-size={P_NODE_HEAP_MB}"] + (["--require", p_patch] if p_patch else []) + [standalone_server]
        cwd = os.path.dirname(standalone_server)
        env = {**os.environ, "PORT": str(NINE_ROUTER_PORT), "NODE_ENV": "production"}
        if node == os.environ.get("OPENSWARM_ELECTRON_PATH"):
            env["ELECTRON_RUN_AS_NODE"] = "1"
    else:
        # Dev: install the pinned npm package into a local cache once, then spawn `node app/server.js` directly (bypasses the package cli.js tray icon users confusingly quit, its update-check spinner, and the TUI).
        cached_server = p_ensure_router_cached()
        if not cached_server:
            return
        node = p_find_node()
        if not node:
            logger.warning("Node.js not found; cannot start 9Router in dev mode.")
            return
        logger.info(
            "Starting 9Router (dev cache, 9router@%s) on port %d...",
            NINE_ROUTER_NPM_VERSION, NINE_ROUTER_PORT,
        )
        cmd = [node, f"--max-old-space-size={P_NODE_HEAP_MB}"] + (["--require", p_patch] if p_patch else []) + [cached_server]
        cwd = os.path.dirname(cached_server)
        env = {**os.environ, "PORT": str(NINE_ROUTER_PORT), "NODE_ENV": "production"}

    # Capture stdout+stderr so a failed start can tell us WHY (the old DEVNULL default made every "router never came up" a silent mystery, which is the whole reason #90 was un-diagnosable). Packaged prod (NODE_ENV=production standalone) is quiet, so one fixed temp file, truncated each start attempt, won't grow; dev keeps its chatty-Next.js DEVNULL unless debug is set.
    p_cap_path = os.path.join(tempfile.gettempdir(), "openswarm-9router-start.log")
    p_cap_file = None
    if p_is_packaged:
        try:
            p_cap_file = open(p_cap_path, "wb")
            p_stdout, p_stderr = p_cap_file, subprocess.STDOUT
        except OSError:
            p_stdout, p_stderr = subprocess.DEVNULL, subprocess.DEVNULL
    elif os.environ.get("OPENSWARM_DEBUG_9ROUTER"):
        p_log_path = os.path.join(
            os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
            "data", "9router.log",
        )
        os.makedirs(os.path.dirname(p_log_path), exist_ok=True)
        p_stdout, p_stderr = open(p_log_path, "a", buffering=1), subprocess.STDOUT
        logger.info(f"9Router debug logging enabled → {p_log_path}")
    else:
        p_stdout, p_stderr = subprocess.DEVNULL, subprocess.DEVNULL

    try:
        p_process = subprocess.Popen(cmd, cwd=cwd, stdout=p_stdout, stderr=p_stderr, env=env)
        if p_cap_file is not None:
            p_cap_file.close()  # the child holds its own fd; the parent copy isn't needed
        timeout = 20 if p_is_packaged else 30
        for _ in range(timeout * 2):
            await asyncio.sleep(0.5)
            if is_running():
                logger.info("9Router started successfully")
                return
        # Verify-at-boot: it never answered. Report with the captured tail + the exit code (non-None = it crashed; None = wedged or just slow).
        p_report_start_failure(
            "not_ready_in_time",
            detail=p_read_capture_tail(p_cap_path) if p_is_packaged else "",
            returncode=p_process.poll(),
            timeout_s=timeout,
        )
    except Exception as e:
        if p_cap_file is not None and not p_cap_file.closed:
            try:
                p_cap_file.close()
            except OSError:
                pass
        p_report_start_failure(
            "spawn_exception",
            detail=f"{e}\n{p_read_capture_tail(p_cap_path) if p_is_packaged else ''}",
        )


def stop():
    """Stop the 9Router subprocess."""
    global p_process, watchdog_task, p_death_watcher_task
    # Cancel the healers FIRST or they would revive the router we're about to kill (shutdown = the one sanctioned "down").
    if watchdog_task is not None:
        watchdog_task.cancel()
        watchdog_task = None
    if p_death_watcher_task is not None:
        p_death_watcher_task.cancel()
        p_death_watcher_task = None
    if p_process:
        try:
            p_process.terminate()
            p_process.wait(timeout=5)
        except Exception:
            try:
                p_process.kill()
            except Exception:
                pass
        p_process = None
        logger.info("9Router stopped")


async def get_usage_stats(period: str = "all") -> dict | None:
    """Get usage statistics from 9Router."""
    try:
        async with httpx.AsyncClient(timeout=5.0, headers=cli_auth_headers()) as client:
            r = await client.get(f"{NINE_ROUTER_API}/usage/stats", params={"period": period})
            if r.status_code == 200:
                return r.json()
    except Exception as e:
        logger.debug(f"9Router usage stats fetch failed: {e}")
    return None


async def get_latest_reasoning_tokens(model_hint: str | None = None) -> int | None:
    """Fetch reasoning_tokens from 9Router for the most recently completed
    request, optionally filtered by model. Returns None if 9Router isn't
    running, the request didn't expose reasoning tokens, or the lookup
    fails for any reason.

    9Router's request-details endpoint returns the most recent N requests
    in reverse chronological order with full token breakdowns including
    `reasoning_tokens` (OpenAI's `completion_tokens_details.reasoning_tokens`)
    and `thoughtsTokenCount` (Gemini's). For Anthropic via 9Router this
    field will be absent/zero; Anthropic doesn't break out reasoning
    tokens in its API response; so callers get None and should fall
    back to the heuristic.
    """
    if not is_running():
        return None
    try:
        async with httpx.AsyncClient(timeout=2.0, headers=cli_auth_headers()) as client:
            params: dict[str, Any] = {"page": 1, "pageSize": 5}
            if model_hint:
                params["model"] = model_hint
            r = await client.get(f"{NINE_ROUTER_API}/usage/request-details", params=params)
            if r.status_code != 200:
                return None
            data = r.json()
            requests = data.get("requests") or data.get("data") or []
            for req in requests:
                tokens = req.get("tokens") or req.get("usage") or {}
                rt = (
                    tokens.get("reasoning_tokens")
                    or tokens.get("thoughtsTokenCount")
                    or tokens.get("thoughts_token_count")
                    or 0
                )
                if rt and int(rt) > 0:
                    return int(rt)
    except Exception as e:
        logger.debug(f"9Router reasoning-token lookup failed: {e}")
    return None


async def get_providers() -> list[dict]:
    """Get all providers and their connection status from 9Router.

    9Router's GET /api/providers returns `{"connections": [...]}`; we
    unwrap so callers always see a plain list of connection dicts.
    """
    try:
        async with httpx.AsyncClient(timeout=5.0, headers=cli_auth_headers()) as client:
            r = await client.get(f"{NINE_ROUTER_API}/providers")
            if r.status_code == 200:
                data = r.json()
                if isinstance(data, dict):
                    return data.get("connections") or []
                if isinstance(data, list):
                    return data
    except Exception as e:
        logger.debug(f"9Router providers fetch failed: {e}")
    return []
