"""Auto-start and manage 9Router subprocess.

9Router is a free AI subscription proxy that lets users connect their
Claude/ChatGPT/Gemini subscriptions to OpenSwarm without API keys.

It runs silently in the background on port 20128 and exposes an
OpenAI-compatible API at localhost:20128/v1.
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
# The fix lives in our /api/openai-passthrough proxy; see openai_passthrough.py
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
        _resources = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        _candidate = os.path.join(_resources, "router")
        if os.path.isdir(_candidate):
            return _candidate
    else:
        _backend_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
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
    here = os.path.dirname(os.path.abspath(__file__))
    candidate = os.path.join(here, "agents", "9router_gpt5_patch.js")
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
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
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


# API-key auth (provider="gemini", authType="apikey") and OAuth hit different
# Google quotas: OAuth uses the Code Assist free tier (aggressively rate-limited;
# 429s on Gemini 3 Pro/Flash even for paid users), while an AI Studio API key
# uses generativelanguage.googleapis.com (independent and far higher). We mirror
# google_api_key into 9Router so the API-key path is preferred when a key is set.

NINE_ROUTER_KEYED_NAME = "AI Studio (OpenSwarm-managed)"
NINE_ROUTER_OPENAI_KEYED_NAME = "OpenAI (OpenSwarm-managed)"
NINE_ROUTER_OPENROUTER_KEYED_NAME = "OpenRouter (OpenSwarm-managed)"
NINE_ROUTER_CLAUDE_PRO_NAME = "OpenSwarm Pro (OpenSwarm-managed)"


async def _find_keyed_connection(provider: str, name: str) -> dict | None:
    """Return the 9Router connection we manage for this provider, if any."""
    conns = await get_providers()
    if not isinstance(conns, list):
        return None
    for c in conns:
        if (
            isinstance(c, dict)
            and c.get("provider") == provider
            and c.get("authType") == "apikey"
            and c.get("name") == name
        ):
            return c
    return None


async def _sync_apikey_provider(
    provider: str,
    api_key: str | None,
    name: str,
    *,
    label: str,
) -> None:
    """Create/update/delete an OpenSwarm-managed apikey connection. Silent if 9Router is down."""
    if not is_running():
        return

    existing = await _find_keyed_connection(provider, name)
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            if api_key:
                payload = {
                    "provider": provider,
                    "authType": "apikey",
                    "name": name,
                    "apiKey": api_key,
                    # Priority 0 = highest. OAuth connections default to 1,
                    # so keyed connections are preferred when both exist.
                    "priority": 0,
                }
                if existing:
                    await client.patch(
                        f"{NINE_ROUTER_API}/providers/{existing['id']}",
                        json=payload,
                    )
                    logger.info(f"9Router: updated {label} API-key connection")
                else:
                    r = await client.post(f"{NINE_ROUTER_API}/providers", json=payload)
                    if r.status_code < 300:
                        logger.info(f"9Router: created {label} API-key connection")
                    else:
                        logger.warning(
                            f"9Router: failed to create {label} API-key connection: "
                            f"{r.status_code} {r.text[:200]}"
                        )
            else:
                if existing:
                    await client.delete(f"{NINE_ROUTER_API}/providers/{existing['id']}")
                    logger.info(f"9Router: removed {label} API-key connection")
    except Exception as e:
        logger.warning(f"9Router {label} API-key sync failed: {e}")


async def sync_gemini_api_key(api_key: str | None) -> None:
    """Mirror google_api_key into 9Router; bypasses Code Assist's tight quota."""
    await _sync_apikey_provider(
        "gemini", api_key, NINE_ROUTER_KEYED_NAME, label="Gemini"
    )


async def sync_openai_api_key(api_key: str | None) -> None:
    """Mirror openai_api_key into 9Router as an `openai-compatible` provider
    node pointed at our local /api/openai-passthrough proxy.

    Why not the built-in `openai` provider type: 9Router 0.3.60 hardcodes
    `https://api.openai.com/v1` for the `openai` provider and ignores any
    `baseUrl` field on the connection. Only the `openai-compatible-*`
    provider-node type honors `baseUrl` (verified statically against
    9Router's compiled bundle). So we register our OpenAI lane AS an
    openai-compatible node; same upstream protocol, different routing.

    Why we route through openai-passthrough at all: OpenAI's GPT-5 family
    rejects the legacy `max_tokens` parameter with HTTP 400, but every
    9Router version (including 0.4.20) emits `max_tokens` in its
    Anthropic→OpenAI translator. The passthrough renames it to
    `max_completion_tokens` for `gpt-5*` models before forwarding to
    api.openai.com. Pre-fix: every gpt-5.* own-key session 400'd silently.

    Companion change: the registry entries `gpt-5.*-api` are routed via
    the `cp-openai/<model>` prefix (set by NINE_ROUTER_OPENAI_KEYED_PREFIX
    below) so 9Router's translator dispatches to this provider-node
    instead of the built-in `openai` provider.
    """
    await _sync_openai_compat_node(api_key)


# Reserved prefix that registry.py's gpt-5.*-api router_model_ids depend on.
# Changing this breaks model resolution for OpenAI own-key users.
NINE_ROUTER_OPENAI_KEYED_PREFIX = "cp-openai"


async def _sync_openai_compat_node(api_key: str | None) -> None:
    """Create / update / delete the openai-compatible node + connection
    pair we use to ferry OpenAI requests through openai-passthrough."""
    if not is_running():
        return
    import os as _os
    port = _os.environ.get("OPENSWARM_PORT", "8324")
    base_url = f"http://127.0.0.1:{port}/api/openai-passthrough/v1"
    managed_name = f"OpenAI{NINE_ROUTER_CUSTOM_NAME_SUFFIX}"

    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.get(f"{NINE_ROUTER_API}/provider-nodes")
            existing_nodes = (r.json().get("nodes") if r.status_code == 200 else []) or []
    except Exception as e:
        logger.warning(f"9Router OpenAI-compat node list failed: {e}")
        return
    existing_node = next(
        (n for n in existing_nodes if isinstance(n, dict) and n.get("prefix") == NINE_ROUTER_OPENAI_KEYED_PREFIX),
        None,
    )

    if not api_key:
        if existing_node:
            try:
                async with httpx.AsyncClient(timeout=5.0) as client:
                    await client.delete(f"{NINE_ROUTER_API}/provider-nodes/{existing_node['id']}")
                logger.info("9Router: removed OpenAI compat node (key cleared)")
            except Exception as e:
                logger.warning(f"9Router OpenAI compat delete failed: {e}")
        return

    node_payload = {
        "name": managed_name,
        "prefix": NINE_ROUTER_OPENAI_KEYED_PREFIX,
        "apiType": "chat",
        "baseUrl": base_url,
        "type": "openai-compatible",
    }
    node_id: str | None = existing_node.get("id") if existing_node else None
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            if existing_node:
                await client.put(
                    f"{NINE_ROUTER_API}/provider-nodes/{existing_node['id']}",
                    json=node_payload,
                )
                logger.info(f"9Router: updated OpenAI compat node {NINE_ROUTER_OPENAI_KEYED_PREFIX}")
            else:
                r = await client.post(
                    f"{NINE_ROUTER_API}/provider-nodes", json=node_payload,
                )
                if r.status_code >= 300:
                    logger.warning(
                        f"9Router: failed to create OpenAI compat node: "
                        f"{r.status_code} {r.text[:200]}"
                    )
                    return
                node_id = (r.json() or {}).get("node", {}).get("id")
                if not node_id:
                    return
                logger.info(f"9Router: created OpenAI compat node {NINE_ROUTER_OPENAI_KEYED_PREFIX} ({node_id})")
    except Exception as e:
        logger.warning(f"9Router OpenAI compat node sync failed: {e}")
        return

    try:
        existing_conn = await _find_keyed_connection(node_id, managed_name)
        conn_payload = {
            "provider": node_id,
            "authType": "apikey",
            "name": managed_name,
            "apiKey": api_key,
            "priority": 0,
        }
        async with httpx.AsyncClient(timeout=5.0) as client:
            if existing_conn:
                await client.patch(
                    f"{NINE_ROUTER_API}/providers/{existing_conn['id']}",
                    json=conn_payload,
                )
            else:
                r = await client.post(f"{NINE_ROUTER_API}/providers", json=conn_payload)
                if r.status_code >= 300:
                    logger.warning(
                        f"9Router: failed to create OpenAI compat connection: "
                        f"{r.status_code} {r.text[:200]}"
                    )
    except Exception as e:
        logger.warning(f"9Router OpenAI compat connection sync failed: {e}")


async def sync_openrouter_api_key(api_key: str | None) -> None:
    """Mirror openrouter_api_key into 9Router; supplies bearer for openrouter/ routes."""
    await _sync_apikey_provider(
        "openrouter", api_key, NINE_ROUTER_OPENROUTER_KEYED_NAME, label="OpenRouter"
    )


# 9Router exposes arbitrary OpenAI-compatible endpoints via "provider nodes"
# (POST /api/provider-nodes, type="openai-compatible"). model_id <prefix>/<model>
# routes to that node's baseUrl. We mirror settings.custom_providers[] with
# prefix `cp-<slug>` so they don't collide with the user's primary OpenAI key.

NINE_ROUTER_CUSTOM_NAME_SUFFIX = " (OpenSwarm-managed)"


def _custom_provider_slug(name: str) -> str:
    """Slugify a user-supplied custom-provider name for use as a 9Router prefix.
    Always returns a non-empty alnum-and-dash string."""
    import re
    s = re.sub(r"[^a-zA-Z0-9-]+", "-", (name or "").strip().lower()).strip("-")
    return s or "custom"


async def sync_custom_providers(providers: list) -> None:
    """Mirror settings.custom_providers into 9Router as openai-compatible nodes.

    Idempotent: existing managed nodes (identified by name suffix) are PUT-updated
    in place, missing ones are POST-created, and any managed node whose prefix is
    no longer in `providers` is deleted (which cascades to its connection).
    Silent no-op when 9Router isn't running.
    """
    if not is_running():
        return

    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.get(f"{NINE_ROUTER_API}/provider-nodes")
            existing_nodes = (r.json().get("nodes") if r.status_code == 200 else []) or []
    except Exception as e:
        logger.warning(f"9Router custom-provider node list failed: {e}")
        return

    managed = [
        n for n in existing_nodes
        if isinstance(n, dict)
        and isinstance(n.get("name"), str)
        and n["name"].endswith(NINE_ROUTER_CUSTOM_NAME_SUFFIX)
    ]
    managed_by_prefix = {n.get("prefix"): n for n in managed if n.get("prefix")}

    seen_prefixes: set[str] = set()
    for cp in providers or []:
        name = getattr(cp, "name", None) or (cp.get("name") if isinstance(cp, dict) else None) or ""
        base_url = getattr(cp, "base_url", None) or (cp.get("base_url") if isinstance(cp, dict) else None) or ""
        api_key = getattr(cp, "api_key", None) or (cp.get("api_key") if isinstance(cp, dict) else None) or ""
        if not name.strip() or not base_url.strip():
            continue
        # Local OpenAI-compat servers (LM Studio, Ollama, etc.) reject a blank
        # Bearer header even with auth disabled. Substitute a placeholder; real
        # auth deployments always have api_key set.
        api_key = api_key.strip() or "no-auth-required"
        slug = _custom_provider_slug(name)
        prefix = f"cp-{slug}"
        seen_prefixes.add(prefix)
        managed_name = f"{name.strip()}{NINE_ROUTER_CUSTOM_NAME_SUFFIX}"

        node = managed_by_prefix.get(prefix)
        node_payload = {
            "name": managed_name,
            "prefix": prefix,
            "apiType": "chat",
            "baseUrl": base_url.strip(),
            "type": "openai-compatible",
        }
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                if node:
                    await client.put(
                        f"{NINE_ROUTER_API}/provider-nodes/{node['id']}",
                        json=node_payload,
                    )
                    node_id = node["id"]
                    logger.info(f"9Router: updated custom node {prefix}")
                else:
                    r = await client.post(
                        f"{NINE_ROUTER_API}/provider-nodes", json=node_payload,
                    )
                    if r.status_code >= 300:
                        logger.warning(
                            f"9Router: failed to create custom node {prefix}: "
                            f"{r.status_code} {r.text[:200]}"
                        )
                        continue
                    node_id = (r.json() or {}).get("node", {}).get("id")
                    if not node_id:
                        continue
                    logger.info(f"9Router: created custom node {prefix} ({node_id})")
        except Exception as e:
            logger.warning(f"9Router custom node {prefix} sync failed: {e}")
            continue

        try:
            existing_conn = await _find_keyed_connection(node_id, managed_name)
            conn_payload = {
                "provider": node_id,
                "authType": "apikey",
                "name": managed_name,
                "apiKey": api_key,
                "priority": 0,
            }
            async with httpx.AsyncClient(timeout=5.0) as client:
                if existing_conn:
                    await client.patch(
                        f"{NINE_ROUTER_API}/providers/{existing_conn['id']}",
                        json=conn_payload,
                    )
                else:
                    r = await client.post(
                        f"{NINE_ROUTER_API}/providers", json=conn_payload,
                    )
                    if r.status_code >= 300:
                        logger.warning(
                            f"9Router: failed to create custom connection {prefix}: "
                            f"{r.status_code} {r.text[:200]}"
                        )
        except Exception as e:
            logger.warning(f"9Router custom connection {prefix} sync failed: {e}")

    # Drop managed nodes no longer in settings; DELETE cascades to connections.
    for prefix, node in managed_by_prefix.items():
        if prefix in seen_prefixes:
            continue
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                await client.delete(f"{NINE_ROUTER_API}/provider-nodes/{node['id']}")
                logger.info(f"9Router: removed orphaned custom node {prefix}")
        except Exception as e:
            logger.warning(f"9Router custom node {prefix} delete failed: {e}")


async def sync_openswarm_pro_as_claude(bearer_token: str | None, proxy_url: str | None) -> None:
    """Register OpenSwarm Pro as a `claude` apikey connection in 9Router,
    pointing at our cloud proxy via `providerSpecificData.baseUrl`.

    This is what makes the CLI's built-in WebSearch work on non-Claude
    primaries for Pro users: the CLI delegates the search execution to
    Anthropic via ANTHROPIC_SMALL_FAST_MODEL (claude-haiku). That small-
    model call hits `ANTHROPIC_BASE_URL` which we've already set to
    localhost:20128 (9Router). Without this sync, 9Router has no Claude
    path for openswarm-pro users, so the search fails with
    "no credentials for provider: claude". With this sync, 9Router sees
    the OpenSwarm-Pro-backed Claude connection and routes the search
    call through our cloud; same quota the user's Pro subscription
    already covers, no extra cost."""
    if not is_running():
        return

    # 9Router's POST /api/providers only accepts direct-API provider ids
    # for apikey auth; `claude` is the subscription/IDE id, `anthropic`
    # is the direct-API id. Use `anthropic`.
    existing = await _find_keyed_connection("anthropic", NINE_ROUTER_CLAUDE_PRO_NAME)
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            if bearer_token and proxy_url:
                payload = {
                    "provider": "anthropic",
                    "authType": "apikey",
                    "name": NINE_ROUTER_CLAUDE_PRO_NAME,
                    "apiKey": bearer_token,
                    # Priority 1 so a real user-owned Claude subscription
                    # (priority 0) still takes precedence if they have one.
                    # Pro is the fallback, not the default.
                    "priority": 1,
                    "providerSpecificData": {
                        "baseUrl": proxy_url.rstrip("/") + "/v1",
                    },
                }
                if existing:
                    await client.patch(
                        f"{NINE_ROUTER_API}/providers/{existing['id']}",
                        json=payload,
                    )
                    logger.info("9Router: updated OpenSwarm Pro → Claude connection")
                else:
                    r = await client.post(f"{NINE_ROUTER_API}/providers", json=payload)
                    if r.status_code < 300:
                        logger.info("9Router: created OpenSwarm Pro → Claude connection")
                    else:
                        logger.warning(
                            f"9Router: failed to create OpenSwarm Pro → Claude connection: {r.status_code} {r.text[:200]}"
                        )
            else:
                if existing:
                    await client.delete(f"{NINE_ROUTER_API}/providers/{existing['id']}")
                    logger.info("9Router: removed OpenSwarm Pro → Claude connection")
    except Exception as e:
        logger.warning(f"9Router OpenSwarm-Pro Claude sync failed: {e}")


# OpenAI's Codex OAuth client is registered with a fixed redirect URI
# `http://localhost:1455/auth/callback` and rejects any other with `unknown_error`.
# Anthropic and Google's clients accept arbitrary localhost callbacks (we use
# 9Router's 20128 callback page). For Codex we spawn a one-shot listener on
# 1455 that serves the same postMessage/BroadcastChannel/localStorage relay so
# the frontend's existing popup + msgHandler flow works unchanged.

_CODEX_CALLBACK_PORT = 1455
_CODEX_CALLBACK_PATH = "/auth/callback"
_CODEX_CALLBACK_HTML = b"""<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Authorization Complete</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;background:#111;color:#eee;
text-align:center;padding:60px 20px;margin:0}h1{font-weight:600;margin:0 0 12px}
p{color:#888;margin:0}</style></head><body>
<h1>Authorization Successful</h1>
<p>This window will close automatically...</p>
<script>
(function() {
  var params = new URLSearchParams(window.location.search);
  var data = {
    code: params.get('code'),
    state: params.get('state'),
    error: params.get('error'),
    errorDescription: params.get('error_description'),
    fullUrl: window.location.href
  };
  // Method 1: postMessage to opener (popup mode -- primary path used by
  // Settings.tsx:316 msgHandler)
  if (window.opener) {
    try { window.opener.postMessage({ type: 'oauth_callback', data: data }, '*'); }
    catch (e) { console.log('postMessage failed:', e); }
  }
  // Method 2: BroadcastChannel (secondary relay for any same-origin listener)
  try { var ch = new BroadcastChannel('oauth_callback'); ch.postMessage(data); ch.close(); }
  catch (e) {}
  // Method 3: localStorage flag (last-resort handoff)
  try { localStorage.setItem('oauth_callback', JSON.stringify(Object.assign({}, data, { timestamp: Date.now() }))); }
  catch (e) {}
  setTimeout(function() { try { window.close(); } catch (e) {} }, 1500);
})();
</script>
</body></html>"""


async def _start_codex_callback_listener(timeout: float = 300.0) -> asyncio.base_events.Server | None:
    """Spawn a one-shot HTTP listener on 127.0.0.1:1455 for the Codex OAuth callback.

    Serves GET /auth/callback with _CODEX_CALLBACK_HTML. After serving the
    callback (or after `timeout` seconds with no callback) the listener
    closes itself in a background task. Safe to call even if 1455 is busy , 
    logs the collision and returns None so start_oauth can still proceed and
    surface whatever error OpenAI returns.

    Also performs the OAuth exchange server-side before serving the HTML.
    Relying on the frontend's postMessage path alone breaks on Windows where
    COOP / popup-opener quirks silently drop the message, leaving the user
    stuck on "Connecting…" until the 30s timeout fires. Exchanging here
    (the same pattern backend/main.py uses for the Gemini callback) makes
    the connection land in 9Router's DB regardless of whether the UI's
    postMessage listener ever gets notified; the Settings / OnboardingModal
    status pollers then pick it up within a couple seconds.
    """

    callback_served = asyncio.Event()

    async def _handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        try:
            # Read the request line ("GET /auth/callback?... HTTP/1.1\r\n")
            raw_request_line = await asyncio.wait_for(reader.readline(), timeout=5.0)
            request_line = raw_request_line.decode("latin-1", errors="replace").strip()
            while True:
                line = await asyncio.wait_for(reader.readline(), timeout=5.0)
                if not line or line in (b"\r\n", b"\n"):
                    break

            # Only respond to the OAuth callback path. Chrome preflights and
            # favicon fetches get a 404 so they don't trigger the served-event.
            parts = request_line.split(" ")
            path = parts[1] if len(parts) >= 2 else ""
            method = parts[0] if parts else ""

            if method == "GET" and path.startswith(_CODEX_CALLBACK_PATH):
                # Parse code/state out of the query string and exchange
                # server-side before serving the HTML. Duplicate exchanges
                # are harmless (single-use auth codes fail the second call,
                # which we swallow) so racing with the frontend's
                # msgHandler-driven exchange is fine.
                try:
                    from urllib.parse import urlparse, parse_qs
                    parsed = urlparse(path)
                    q = parse_qs(parsed.query)
                    code = (q.get("code") or [""])[0]
                    state = (q.get("state") or [""])[0]
                    if code and state:
                        try:
                            from backend.main import _pending_oauth, _mark_oauth_completed
                        except Exception:
                            _pending_oauth = None
                            _mark_oauth_completed = None

                        if _pending_oauth is not None:
                            pending = _pending_oauth.pop(state, None)
                            if pending:
                                try:
                                    await exchange_oauth(
                                        pending["provider"],
                                        code,
                                        pending["redirect_uri"],
                                        pending["code_verifier"],
                                        state,
                                    )
                                    if _mark_oauth_completed is not None:
                                        _mark_oauth_completed(state)
                                    logger.info(
                                        f"Codex callback: server-side exchange succeeded for state {state[:8]}..."
                                    )
                                except Exception as e:
                                    # Put the pending entry back so the
                                    # frontend's msgHandler retry via
                                    # /agents/subscriptions/exchange still
                                    # has a shot. Safe because we only popped
                                    # it a moment ago.
                                    _pending_oauth[state] = pending
                                    logger.debug(
                                        f"Codex callback: server-side exchange failed ({e}); leaving for frontend retry"
                                    )
                except Exception as e:
                    logger.debug(f"Codex callback listener pre-exchange error: {e}")

                body = _CODEX_CALLBACK_HTML
                response = (
                    b"HTTP/1.1 200 OK\r\n"
                    b"Content-Type: text/html; charset=utf-8\r\n"
                    b"Content-Length: " + str(len(body)).encode("ascii") + b"\r\n"
                    b"Cache-Control: no-store\r\n"
                    b"Connection: close\r\n\r\n"
                    + body
                )
                writer.write(response)
                await writer.drain()
                callback_served.set()
            else:
                writer.write(
                    b"HTTP/1.1 404 Not Found\r\n"
                    b"Content-Length: 0\r\n"
                    b"Connection: close\r\n\r\n"
                )
                await writer.drain()
        except Exception as e:
            logger.debug(f"Codex callback listener handler error: {e}")
        finally:
            try:
                writer.close()
                await writer.wait_closed()
            except Exception:
                pass

    try:
        server = await asyncio.start_server(_handle, "127.0.0.1", _CODEX_CALLBACK_PORT)
    except OSError as e:
        # Port already in use; probably another Codex connect attempt still
        # running, or an actual Codex CLI process holding 1455. Log and bail.
        logger.warning(
            f"Could not start Codex callback listener on port {_CODEX_CALLBACK_PORT}: {e}. "
            "If another connection attempt is in progress, wait for it to finish or time out."
        )
        return None

    async def _lifecycle():
        try:
            await asyncio.wait_for(callback_served.wait(), timeout=timeout)
            # Give the served HTML a moment to run its JS (postMessage +
            # window.close) before we close the socket. Chromium closes
            # the tab on window.close() but the JS needs to run first.
            await asyncio.sleep(2.0)
        except asyncio.TimeoutError:
            logger.info(f"Codex callback listener timed out after {timeout}s")
        except Exception as e:
            logger.debug(f"Codex callback listener lifecycle error: {e}")
        finally:
            try:
                server.close()
                await server.wait_closed()
            except Exception:
                pass

    asyncio.create_task(_lifecycle())
    logger.info(f"Started Codex callback listener on http://localhost:{_CODEX_CALLBACK_PORT}{_CODEX_CALLBACK_PATH}")
    return server


# Providers whose OAuth flow MUST run in the user's real browser via
# shell.openExternal, not the in-Electron window.open popup:
# - gemini-cli, antigravity: Google's Embedded WebView Restrictions policy uses
#   JS-fingerprint detection that no UA spoof defeats. RFC 8252 and Google's
#   own Desktop-app OAuth guidance both prescribe the system browser.
# - codex: auth.openai.com renders blank in our popup on some machines (newer
#   embed detection + regional checks); system browser surfaces the real error.
# The callback for gemini-cli/antigravity lands on /api/subscriptions/callback
# and runs the exchange server-side; codex uses its fixed 1455 listener.
_EXTERNAL_BROWSER_PROVIDERS: set[str] = {"gemini-cli", "antigravity", "codex"}


def _should_use_external_browser(provider: str) -> bool:
    return provider in _EXTERNAL_BROWSER_PROVIDERS


def _backend_port() -> int:
    """Best-effort lookup of the OpenSwarm backend HTTP port.

    Falls back to 8324 (the default in backend/main.py) if OPENSWARM_PORT
    hasn't been set yet. backend/main.py:239 sets this env var at startup
    before any request handler runs, so `start_oauth` will always see the
    correct value.
    """
    try:
        return int(os.environ.get("OPENSWARM_PORT", "8324"))
    except (TypeError, ValueError):
        return 8324


def _callback_uri_for_provider(provider: str) -> str:
    """Return the redirect URI to pass to 9Router's authorize endpoint.

    Most providers accept 9Router's built-in callback page at port 20128.
    Two special cases:
    - Codex/OpenAI's OAuth client is bound to a fixed
      http://localhost:1455/auth/callback URI; handled by
      _start_codex_callback_listener above.
    - Gemini/Google's OAuth consent page rejects embedded browsers, so we
      route the callback through OpenSwarm's backend endpoint at
      /api/subscriptions/callback (backend/main.py:138) which runs the
      exchange itself. This is the only provider where the callback lands
      on OpenSwarm's port rather than 9Router's.
    """
    if provider == "codex":
        return f"http://localhost:{_CODEX_CALLBACK_PORT}{_CODEX_CALLBACK_PATH}"
    if provider in _EXTERNAL_BROWSER_PROVIDERS:
        return f"http://localhost:{_backend_port()}/api/subscriptions/callback"
    return f"http://localhost:{NINE_ROUTER_PORT}/callback"


async def start_oauth(provider: str) -> dict:
    """Start OAuth flow for a provider.

    For device_code providers (github, qwen, kiro): returns {user_code, verification_uri, device_code}
    For authorization_code providers (claude, codex, gemini-cli): returns {authUrl, codeVerifier, state}
    """
    async with httpx.AsyncClient(timeout=15.0) as client:
        try:
            r = await client.get(f"{NINE_ROUTER_API}/oauth/{provider}/device-code")
            if r.status_code == 200:
                data = r.json()
                return {
                    "flow": "device_code",
                    "user_code": data.get("user_code", ""),
                    "verification_uri": data.get("verification_uri", data.get("verification_uri_complete", "")),
                    "device_code": data.get("device_code", ""),
                    "code_verifier": data.get("codeVerifier", ""),
                    "extra_data": {k: v for k, v in data.items() if k.startswith("_")},
                }
        except Exception:
            pass

        callback_url = _callback_uri_for_provider(provider)
        if provider == "codex":
            await _start_codex_callback_listener()

        r = await client.get(
            f"{NINE_ROUTER_API}/oauth/{provider}/authorize",
            params={"redirect_uri": callback_url},
        )
        r.raise_for_status()
        data = r.json()
        return {
            "flow": "authorization_code",
            "auth_url": data.get("authUrl", ""),
            "code_verifier": data.get("codeVerifier", ""),
            "state": data.get("state", ""),
            "redirect_uri": callback_url,
            "use_external_browser": _should_use_external_browser(provider),
        }


async def poll_oauth(provider: str, device_code: str, code_verifier: str | None = None, extra_data: dict | None = None) -> dict:
    """Poll for OAuth completion.

    Returns: {success: true, connection: {...}} or {success: false, pending: true}
    """
    body: dict = {"deviceCode": device_code}
    if code_verifier:
        body["codeVerifier"] = code_verifier
    if extra_data:
        body["extraData"] = extra_data

    async with httpx.AsyncClient(timeout=15.0) as client:
        r = await client.post(
            f"{NINE_ROUTER_API}/oauth/{provider}/poll",
            json=body,
        )
        r.raise_for_status()
        return r.json()


async def exchange_oauth(provider: str, code: str, redirect_uri: str, code_verifier: str, state: str = "") -> dict:
    """Exchange OAuth code for tokens via 9Router."""
    async with httpx.AsyncClient(timeout=15.0) as client:
        r = await client.post(
            f"{NINE_ROUTER_API}/oauth/{provider}/exchange",
            json={
                "code": code,
                "redirectUri": redirect_uri,
                "codeVerifier": code_verifier,
                "state": state,
            },
        )
        r.raise_for_status()
        return r.json()


async def get_models() -> list[dict]:
    """Get all available models from 9Router."""
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.get(f"{NINE_ROUTER_V1}/models")
            if r.status_code == 200:
                data = r.json()
                models = data.get("data", [])
                return [
                    {
                        "value": m.get("id", ""),
                        "label": m.get("id", "").split("/")[-1] if "/" in m.get("id", "") else m.get("id", ""),
                        "context_window": 200_000,
                        "provider": m.get("owned_by", "subscription"),
                    }
                    for m in models
                ]
    except Exception as e:
        logger.debug(f"9Router models fetch failed: {e}")
    return []
