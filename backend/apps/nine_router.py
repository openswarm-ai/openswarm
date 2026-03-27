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

import httpx

logger = logging.getLogger(__name__)

NINE_ROUTER_PORT = 20128
NINE_ROUTER_URL = f"http://localhost:{NINE_ROUTER_PORT}"
NINE_ROUTER_API = f"{NINE_ROUTER_URL}/api"
NINE_ROUTER_V1 = f"{NINE_ROUTER_URL}/v1"

_process: subprocess.Popen | None = None


def is_running() -> bool:
    """Check if 9Router is running."""
    try:
        r = httpx.get(f"{NINE_ROUTER_V1}/models", timeout=2.0)
        return r.status_code == 200
    except Exception:
        return False


def _find_9router_dir() -> str | None:
    """Locate the bundled 9Router directory (works in both dev and packaged mode)."""
    _is_packaged = os.environ.get("OPENSWARM_PACKAGED") == "1"

    if _is_packaged:
        # Packaged Electron app — 9router is in extraResources
        import sys
        # In packaged mode, backend is at <resources>/backend/
        # So 9router is at <resources>/9router/
        _resources = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        _candidate = os.path.join(_resources, "9router")
        if os.path.isdir(_candidate):
            return _candidate
    else:
        # Dev mode — 9router is at project root
        _backend_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        _project_root = os.path.dirname(_backend_dir)
        _candidate = os.path.join(_project_root, "9router")
        if os.path.isdir(_candidate):
            return _candidate

    return None


def _find_node() -> str | None:
    """Find a Node.js binary (works in both dev and packaged mode)."""
    # Check system node first
    node = shutil.which("node")
    if node:
        return node

    # In packaged Electron app, use the Electron binary with ELECTRON_RUN_AS_NODE=1
    electron_path = os.environ.get("OPENSWARM_ELECTRON_PATH")
    if electron_path and os.path.exists(electron_path):
        return electron_path

    return None


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
                    import asyncio
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
        # Production mode — use pre-built standalone server
        # In packaged app, build-staging copies .next/standalone/ contents to 9router/
        # So server.js is at 9router/server.js (not 9router/.next/standalone/server.js)
        standalone_server = os.path.join(_9router_dir, "server.js")
        if not os.path.exists(standalone_server):
            # Fallback: check nested path in case build layout changes
            standalone_server = os.path.join(_9router_dir, ".next", "standalone", "server.js")
        if not os.path.exists(standalone_server):
            logger.warning("9Router standalone build not found in %s", _9router_dir)
            return

        node = _find_node()
        if not node:
            logger.warning("Node.js not found — cannot start 9Router in packaged mode.")
            return

        logger.info("Starting 9Router (production) on port %d...", NINE_ROUTER_PORT)
        cmd = [node, standalone_server]
        cwd = os.path.dirname(standalone_server)
        env = {**os.environ, "PORT": str(NINE_ROUTER_PORT), "NODE_ENV": "production"}
        # If using Electron binary as node, enable ELECTRON_RUN_AS_NODE
        if node == os.environ.get("OPENSWARM_ELECTRON_PATH"):
            env["ELECTRON_RUN_AS_NODE"] = "1"

    elif _9router_dir:
        # Dev mode with bundled 9Router — use next dev
        npx = shutil.which("npx")
        if not npx:
            logger.warning("npx not found — cannot auto-start 9Router.")
            return

        # Install deps if needed
        if not os.path.isdir(os.path.join(_9router_dir, "node_modules")):
            logger.info("Installing 9Router dependencies...")
            npm = shutil.which("npm")
            if npm:
                subprocess.run([npm, "install"], cwd=_9router_dir,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=120)

        logger.info("Starting 9Router (dev) on port %d...", NINE_ROUTER_PORT)
        cmd = [npx, "next", "dev", "--webpack", "-p", str(NINE_ROUTER_PORT)]
        cwd = _9router_dir
        env = {**os.environ, "PORT": str(NINE_ROUTER_PORT)}

    else:
        # No bundled 9Router — try npx 9router as last resort
        npx = shutil.which("npx")
        if not npx:
            logger.warning("npx not found and no bundled 9Router — cannot start.")
            return
        logger.info("Starting 9Router (npx) on port %d...", NINE_ROUTER_PORT)
        cmd = [npx, "9router"]
        cwd = None
        env = {**os.environ, "PORT": str(NINE_ROUTER_PORT)}

    try:
        _process = subprocess.Popen(
            cmd,
            cwd=cwd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env=env,
        )

        # Wait up to 30 seconds for startup (production standalone is faster)
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


# ---------------------------------------------------------------------------
# API proxy helpers — call 9Router's API from OpenSwarm
# ---------------------------------------------------------------------------

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


async def get_providers() -> list[dict]:
    """Get all providers and their connection status from 9Router."""
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.get(f"{NINE_ROUTER_API}/providers")
            if r.status_code == 200:
                return r.json()
    except Exception as e:
        logger.debug(f"9Router providers fetch failed: {e}")
    return []


async def start_oauth(provider: str) -> dict:
    """Start OAuth flow for a provider.

    For device_code providers (github, qwen, kiro): returns {user_code, verification_uri, device_code}
    For authorization_code providers (claude, codex, gemini-cli): returns {authUrl, codeVerifier, state}
    """
    async with httpx.AsyncClient(timeout=15.0) as client:
        # Try device-code flow first
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

        # Authorization code flow — redirect to 9Router's own callback page
        # (Anthropic only accepts redirect URIs registered with 9Router's client ID)
        callback_url = f"http://localhost:{NINE_ROUTER_PORT}/callback"
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
