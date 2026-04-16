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

import httpx

logger = logging.getLogger(__name__)

NINE_ROUTER_PORT = 20128
NINE_ROUTER_URL = f"http://localhost:{NINE_ROUTER_PORT}"
NINE_ROUTER_API = f"{NINE_ROUTER_URL}/api"
NINE_ROUTER_V1 = f"{NINE_ROUTER_URL}/v1"

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

    # By default, 9Router's stdout/stderr go to /dev/null (Next.js dev mode
    # is extremely chatty and floods the openswarm console otherwise). When
    # debugging is needed, set OPENSWARM_DEBUG_9ROUTER=1 in the environment
    # before launching the backend — output will then be appended to
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


# ---------------------------------------------------------------------------
# Per-provider OAuth redirect URIs
# ---------------------------------------------------------------------------
#
# Each upstream OAuth client is registered with the identity provider against
# a specific redirect URI. Anthropic's Claude Code client is lenient — any
# `http://localhost:*/callback` works — so we can use 9Router's built-in
# callback page at port 20128 for it. OpenAI's Codex client is NOT: it's
# registered with `http://localhost:1455/auth/callback` and OpenAI rejects
# any other redirect_uri with `unknown_error` at the auth page. Google's
# Gemini CLI client accepts arbitrary localhost URIs so we keep 20128 there.
#
# For Codex specifically we spawn a one-shot HTTP listener on port 1455
# below that serves a callback page mirroring 9Router's callback page —
# postMessage to window.opener, BroadcastChannel fan-out, then close. This
# lets the frontend reuse its existing Claude/Anthropic flow unchanged
# (window.open popup + postMessage handler in Settings.tsx).

_CODEX_CALLBACK_PORT = 1455
_CODEX_CALLBACK_PATH = "/auth/callback"

# Minimal callback page inlined as bytes. Mirrors 9router/src/app/callback/
# page.js:27-55 — posts the OAuth data to window.opener via postMessage,
# BroadcastChannel, and localStorage so whatever detection path the caller
# is using will fire. Served to the Electron popup that OAuth redirects to.
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
    closes itself in a background task. Safe to call even if 1455 is busy —
    logs the collision and returns None so start_oauth can still proceed and
    surface whatever error OpenAI returns.
    """

    callback_served = asyncio.Event()

    async def _handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        try:
            # Read the request line ("GET /auth/callback?... HTTP/1.1\r\n")
            raw_request_line = await asyncio.wait_for(reader.readline(), timeout=5.0)
            request_line = raw_request_line.decode("latin-1", errors="replace").strip()
            # Drain headers so the browser's request is fully consumed
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
                # Unrelated request (favicon, preflight) — 404 and move on
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
        # Port already in use — probably another Codex connect attempt still
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


# Providers that cannot use the in-Electron `window.open` popup flow and
# must be opened in the user's system browser instead.
#
# Google enforces an "Embedded WebView Restrictions" policy on its OAuth
# consent pages that uses JS-based fingerprinting, not just user-agent
# sniffing. We tried defeating it with a combination of Chrome UA spoof +
# sandboxed webPreferences + fresh session partition + a preload script
# that patches navigator.webdriver/plugins/mimeTypes/languages/chrome and
# overrides navigator.permissions.query — it was still rejected. Google's
# detection is a moving target and actively adversarial. The supported
# workaround (and what Google recommends for Desktop app OAuth) is to run
# the flow in the user's real browser via shell.openExternal.
#
# When a provider is in this set the frontend calls
# window.openswarm.openExternal (shell.openExternal) instead of
# window.open, and the callback lands on OpenSwarm's own
# /api/subscriptions/callback endpoint (backend/main.py:138) which
# exchanges the code and serves a "Connected!" page. Detection on the
# OpenSwarm side happens via the existing status poller on the
# Settings page.
_EXTERNAL_BROWSER_PROVIDERS: set[str] = {"gemini-cli"}


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
      http://localhost:1455/auth/callback URI — handled by
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

        # Authorization code flow. Most providers accept 9Router's own
        # callback page at port 20128, but Codex's OAuth client is bound
        # to a fixed http://localhost:1455/auth/callback URI — spawn an
        # in-process listener on that port before returning the auth URL,
        # so the popup can redirect there after login and relay the code
        # back to the frontend via postMessage (same flow as Claude).
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
