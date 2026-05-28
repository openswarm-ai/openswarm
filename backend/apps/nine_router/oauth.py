"""9Router OAuth flow: start/poll/exchange + the Codex 1455 callback listener.

Talks to the already-running 9Router over HTTP; never spawns the subprocess
(that's process.py's job).
"""

import asyncio
import logging
import os

import httpx

from .process import NINE_ROUTER_API, NINE_ROUTER_PORT, NINE_ROUTER_V1
from backend.apps.oauth_state import _pending_oauth, _mark_oauth_completed

logger = logging.getLogger(__name__)

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
