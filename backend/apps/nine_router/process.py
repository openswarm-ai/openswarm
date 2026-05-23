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
import logging
import os
import shutil
import subprocess
import time
from typing import Any

import httpx

logger = logging.getLogger(__name__)

NINE_ROUTER_PORT = 20128
NINE_ROUTER_URL = f"http://localhost:{NINE_ROUTER_PORT}"
NINE_ROUTER_API = f"{NINE_ROUTER_URL}/api"
NINE_ROUTER_V1 = f"{NINE_ROUTER_URL}/v1"

# Pinned 9router npm package version. Using 0.3.60 to match exactly what
# openswarm-ai v1.0.25 (last known-good production release) vendored via
# `9router/package.json`. Versions between 0.3.60 and 0.3.96 regressed
# cross-provider WebSearch: the CLI's WebSearch call from Codex/Gemini
# primaries used to route cleanly through 9Router's translator and hit
# Anthropic's server-side web_search (returning real results), but later
# translator changes broke that path; non-Claude primaries now see
# "claude-haiku-4-5-20251001 unavailable" or hallucinated output.
# Pinning to 0.3.60 restores v1.0.25 behavior.
#
# Note: 0.3.60-0.4.20 ALL emit `max_tokens` (not max_completion_tokens)
# when translating Anthropic→OpenAI, which OpenAI's GPT-5 family rejects.
# The fix lives in our /api/openai-passthrough proxy; see core/openai_passthrough.py
# and sync_openai_api_key for how the translation lane is rerouted via an
# `openai-compatible` provider-node that honors `baseUrl`.
NINE_ROUTER_NPM_VERSION = "0.3.60"

_process: subprocess.Popen | None = None

# Short TTL cache for positive is_running() results. The probe is a sync
# httpx.get that blocks the event loop, and under load (9Router busy
# streaming inference) it can exceed its 2s timeout and return False even
# though 9Router is fine. Caching a recent True result avoids those false
# negatives without masking a real crash for more than _IS_RUNNING_TTL seconds.
# Negative results are NOT cached so startup detection in ensure_running()
# remains correct.
_IS_RUNNING_TTL = 10.0
_is_running_last_ok: float = 0.0


def is_running() -> bool:
    """Check if 9Router is running."""
    global _is_running_last_ok
    now = time.monotonic()
    if now - _is_running_last_ok < _IS_RUNNING_TTL:
        return True
    try:
        r = httpx.get(f"{NINE_ROUTER_V1}/models", timeout=2.0)
        if r.status_code == 200:
            _is_running_last_ok = now
            return True
        return False
    except Exception:
        return False


def _find_9router_dir() -> str | None:
    """Locate the bundled 9Router directory (works in both dev and packaged mode)."""
    _is_packaged = os.environ.get("OPENSWARM_PACKAGED") == "1"

    if _is_packaged:
        import sys
        _resources = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
        _candidate = os.path.join(_resources, "router")
        if os.path.isdir(_candidate):
            return _candidate
    else:
        _backend_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        _project_root = os.path.dirname(_backend_dir)
        _candidate = os.path.join(_project_root, "router")
        if os.path.isdir(_candidate):
            return _candidate

    return None


def _gpt5_patch_path() -> str | None:
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


def _find_node() -> str | None:
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


def _dev_router_cache_dir() -> str:
    """Cache dir for the npm 9router package used in dev mode.

    Pinned per version so bumping NINE_ROUTER_NPM_VERSION triggers a fresh
    install instead of reusing a stale cache.
    """
    base = os.environ.get("XDG_CACHE_HOME") or os.path.join(
        os.path.expanduser("~"), ".cache"
    )
    return os.path.join(base, "openswarm-router", NINE_ROUTER_NPM_VERSION)


def _ensure_router_cached() -> str | None:
    """Ensure the npm 9router package is installed in the dev cache.

    Returns the absolute path to `app/server.js` on success, or None if
    npm isn't available or the install fails. Idempotent; returns
    immediately when the server file already exists.

    Running `node app/server.js` directly (instead of `npx 9router`)
    skips the CLI wrapper, which means no systray menu-bar icon,
    no update-check spinner, and no accidental-quit foot-gun when a
    non-developer right-clicks the "9" tray icon and picks Quit.
    """
    cache_dir = _dev_router_cache_dir()
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
        # Note: we do NOT pass --ignore-scripts. The package's postinstall
        # rebuilds better-sqlite3 for the host platform; skipping it leaves
        # the server unable to load its native addon.
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


async def ensure_running():
    """Start 9Router if not already running."""
    global _process
    _is_packaged = os.environ.get("OPENSWARM_PACKAGED") == "1"

    if is_running():
        # In dev mode, kill stale standalone servers (from previous builds)
        # so we can start `next dev` which always uses latest source code
        if not _is_packaged:
            import subprocess as _sp
            try:
                result = _sp.run(
                    ["pgrep", "-f", "next-server"],
                    capture_output=True, text=True, timeout=3,
                )
                if result.stdout.strip():
                    logger.info("Dev mode: killing stale standalone 9Router to use next dev instead")
                    _sp.run(["pkill", "-f", "next-server"], timeout=5)
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
    _9router_dir = _find_9router_dir()

    if _is_packaged and _9router_dir:
        # Packaged mode; run the pre-built standalone server staged at
        # <resources>/router/server.js by scripts/fetch-router.sh at build time.
        standalone_server = os.path.join(_9router_dir, "server.js")
        if not os.path.exists(standalone_server):
            standalone_server = os.path.join(_9router_dir, ".next", "standalone", "server.js")
        if not os.path.exists(standalone_server):
            logger.warning("9Router standalone build not found in %s", _9router_dir)
            return

        node = _find_node()
        if not node:
            logger.warning("Node.js not found; cannot start 9Router in packaged mode.")
            return

        logger.info("Starting 9Router (production) on port %d...", NINE_ROUTER_PORT)
        cmd = [node]
        _patch = _gpt5_patch_path()
        if _patch:
            cmd += ["--require", _patch]
        cmd.append(standalone_server)
        cwd = os.path.dirname(standalone_server)
        env = {**os.environ, "PORT": str(NINE_ROUTER_PORT), "NODE_ENV": "production"}
        if node == os.environ.get("OPENSWARM_ELECTRON_PATH"):
            env["ELECTRON_RUN_AS_NODE"] = "1"

    else:
        # Dev mode; install the pinned 9router npm package into a local
        # cache the first time run.sh boots, then spawn `node app/server.js`
        # directly on subsequent launches. Bypassing the package's cli.js
        # avoids its menu-bar tray icon (which users confusingly quit,
        # silently killing their subscription routing), its update-check
        # spinner, and the interactive TUI.
        cached_server = _ensure_router_cached()
        if not cached_server:
            return

        node = _find_node()
        if not node:
            logger.warning("Node.js not found; cannot start 9Router in dev mode.")
            return

        logger.info(
            "Starting 9Router (dev cache, 9router@%s) on port %d...",
            NINE_ROUTER_NPM_VERSION, NINE_ROUTER_PORT,
        )
        cmd = [node]
        _patch = _gpt5_patch_path()
        if _patch:
            cmd += ["--require", _patch]
        cmd.append(cached_server)
        cwd = os.path.dirname(cached_server)
        env = {**os.environ, "PORT": str(NINE_ROUTER_PORT), "NODE_ENV": "production"}

    # By default, 9Router's stdout/stderr go to /dev/null (Next.js dev mode
    # is extremely chatty and floods the openswarm console otherwise). When
    # debugging is needed, set OPENSWARM_DEBUG_9ROUTER=1 in the environment
    # before launching the backend; output will then be appended to
    # backend/data/9router.log line-buffered, which can be `tail -f`'d.
    if os.environ.get("OPENSWARM_DEBUG_9ROUTER"):
        _log_path = os.path.join(
            os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
            "data",
            "9router.log",
        )
        os.makedirs(os.path.dirname(_log_path), exist_ok=True)
        _stdout = open(_log_path, "a", buffering=1)  # line-buffered
        _stderr = subprocess.STDOUT
        logger.info(f"9Router debug logging enabled → {_log_path}")
    else:
        _stdout = subprocess.DEVNULL
        _stderr = subprocess.DEVNULL

    try:
        _process = subprocess.Popen(
            cmd,
            cwd=cwd,
            stdout=_stdout,
            stderr=_stderr,
            env=env,
        )

        timeout = 20 if _is_packaged else 30
        for _ in range(timeout * 2):
            await asyncio.sleep(0.5)
            if is_running():
                logger.info("9Router started successfully")
                return

        logger.warning("9Router did not start within %ds", timeout)
    except Exception as e:
        logger.warning(f"Failed to start 9Router: {e}")


def stop():
    """Stop the 9Router subprocess."""
    global _process
    if _process:
        try:
            _process.terminate()
            _process.wait(timeout=5)
        except Exception:
            try:
                _process.kill()
            except Exception:
                pass
        _process = None
        logger.info("9Router stopped")


async def get_usage_stats(period: str = "all") -> dict | None:
    """Get usage statistics from 9Router."""
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
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
        async with httpx.AsyncClient(timeout=2.0) as client:
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
        async with httpx.AsyncClient(timeout=5.0) as client:
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
