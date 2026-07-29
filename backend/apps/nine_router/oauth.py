"""9Router OAuth flow: start/poll/exchange + the Codex 1455 callback listener.

Talks to the already-running 9Router over HTTP; never spawns the subprocess
(that's process.py's job).
"""

import asyncio
import logging
import os
from typing import Optional

import httpx

from backend.apps.nine_router.process import NINE_ROUTER_API, NINE_ROUTER_PORT, NINE_ROUTER_V1, cli_auth_headers
from backend.apps.oauth_state import pending_oauth, mark_oauth_completed

logger = logging.getLogger(__name__)

# OpenAI's Codex OAuth client is registered with a fixed redirect URI `http://localhost:1455/auth/callback` and rejects any other with `unknown_error`. Anthropic and Google's clients accept arbitrary localhost callbacks (we use 9Router's 20128 callback page). For Codex we spawn a one-shot listener on 1455 that serves the same postMessage/BroadcastChannel/localStorage relay so the frontend's existing popup + msgHandler flow works unchanged.

# OpenAI's Codex OAuth client registers BOTH loopback redirect ports in its Hydra allow-list (1455 default, 1457 fallback) and the official Codex CLI falls back to 1457 for the "another app holds 1455" case (openai/codex PR #19334), so we try them in order and reject anything off the list.
P_CODEX_CALLBACK_PORTS = (1455, 1457)
P_CODEX_CALLBACK_PORT = P_CODEX_CALLBACK_PORTS[0]
P_CODEX_CALLBACK_PATH = "/auth/callback"
P_CODEX_CALLBACK_HTML = b"""<!DOCTYPE html>
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


# Tracks the live Codex callback listener so a fresh connect can reclaim a port from a still-bound prior attempt instead of failing to bind and leaving OpenAI's redirect unanswered.
p_codex_listener_server: "asyncio.base_events.Server | None" = None


async def p_start_codex_callback_listener(timeout: float = 300.0) -> int | None:
    """Spawn a one-shot HTTP listener on the first free Codex callback port and return it.

    Tries each of P_CODEX_CALLBACK_PORTS (1455 then 1457, both on OpenAI's allow-list) and
    binds the first that's free, returning the bound port so the caller builds the matching
    redirect_uri. Serves GET /auth/callback with P_CODEX_CALLBACK_HTML. After serving the
    callback (or after `timeout` seconds with no callback) the listener closes itself in a
    background task. Returns None only when EVERY allow-listed port is held by another app,
    so start_oauth can fail fast with an actionable message instead of a dead-end flow.

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

    async def p_handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        try:
            # Read the request line ("GET /auth/callback?... HTTP/1.1\r\n")
            raw_request_line = await asyncio.wait_for(reader.readline(), timeout=5.0)
            request_line = raw_request_line.decode("latin-1", errors="replace").strip()
            while True:
                line = await asyncio.wait_for(reader.readline(), timeout=5.0)
                if not line or line in (b"\r\n", b"\n"):
                    break

            # Only respond to the OAuth callback path. Chrome preflights and favicon fetches get a 404 so they don't trigger the served-event.
            parts = request_line.split(" ")
            path = parts[1] if len(parts) >= 2 else ""
            method = parts[0] if parts else ""

            if method == "GET" and path.startswith(P_CODEX_CALLBACK_PATH):
                # Parse code/state out of the query string and exchange server-side before serving the HTML. Duplicate exchanges are harmless (single-use auth codes fail the second call, which we swallow) so racing with the frontend's msgHandler-driven exchange is fine.
                try:
                    from urllib.parse import urlparse, parse_qs
                    parsed = urlparse(path)
                    q = parse_qs(parsed.query)
                    code = (q.get("code") or [""])[0]
                    state = (q.get("state") or [""])[0]
                    if code and state:
                        pending = pending_oauth.pop(state, None)
                        if pending:
                            try:
                                await exchange_oauth(
                                    pending["provider"],
                                    code,
                                    pending["redirect_uri"],
                                    pending["code_verifier"],
                                    state,
                                )
                                mark_oauth_completed(state)
                                logger.info(
                                    f"Codex callback: server-side exchange succeeded for state {state[:8]}..."
                                )
                            except Exception as e:
                                # Put the pending entry back so the frontend's msgHandler retry via /agents/subscriptions/exchange still has a shot. Safe because we only popped it a moment ago.
                                pending_oauth[state] = pending
                                logger.debug(
                                    f"Codex callback: server-side exchange failed ({e}); leaving for frontend retry"
                                )
                except Exception as e:
                    logger.debug(f"Codex callback listener pre-exchange error: {e}")

                body = P_CODEX_CALLBACK_HTML
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

    global p_codex_listener_server
    # A new connect supersedes any abandoned one: close our own still-bound prior listener first so this attempt can take the port instead of colliding.
    if p_codex_listener_server is not None:
        try:
            p_codex_listener_server.close()
            await p_codex_listener_server.wait_closed()
        except Exception:
            pass
        p_codex_listener_server = None

    # Try each allow-listed port; the first free one wins (a running Codex CLI / ChatGPT extension typically holds 1455, so we land on 1457).
    server = None
    bound_port = None
    for port in P_CODEX_CALLBACK_PORTS:
        try:
            server = await asyncio.start_server(p_handle, "127.0.0.1", port)
            bound_port = port
            break
        except OSError:
            continue
    if server is None:
        # Every allow-listed port is held by another app; OpenAI accepts only these two redirect ports so we can't pick a third, bail and let the UI tell the user.
        ports = "/".join(str(p) for p in P_CODEX_CALLBACK_PORTS)
        logger.warning(
            f"Could not start Codex callback listener: ports {ports} are all in use by "
            f"another app (Codex CLI / ChatGPT extension). Close it (lsof -i :{P_CODEX_CALLBACK_PORTS[0]}) and retry."
        )
        return None
    p_codex_listener_server = server

    async def p_lifecycle():
        try:
            await asyncio.wait_for(callback_served.wait(), timeout=timeout)
            # Give the served HTML a moment to run its JS (postMessage + window.close) before we close the socket. Chromium closes the tab on window.close() but the JS needs to run first.
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
            global p_codex_listener_server
            if p_codex_listener_server is server:
                p_codex_listener_server = None

    asyncio.create_task(p_lifecycle())
    logger.info(f"Started Codex callback listener on http://localhost:{bound_port}{P_CODEX_CALLBACK_PATH}")
    return bound_port


# Providers whose OAuth flow MUST run in the user's real browser via shell.openExternal, not the in-Electron window.open popup: - gemini-cli, antigravity: Google's Embedded WebView Restrictions policy uses JS-fingerprint detection that no UA spoof defeats. RFC 8252 and Google's own Desktop-app OAuth guidance both prescribe the system browser. - codex: auth.openai.com renders blank in our popup on some machines (newer embed detection + regional checks); system browser surfaces the real error. - claude: email magic-link opens in the user's default browser, which is a different cookie jar from the embedded popup, so the popup can never receive the auth. Forcing the OAuth flow into the system browser keeps everything in one cookie jar. The callback for gemini-cli/antigravity lands on /api/subscriptions/callback and runs the exchange server-side; codex uses its fixed 1455 listener; claude is special-cased in callback_uri_for_provider below.
P_EXTERNAL_BROWSER_PROVIDERS: set[str] = {"gemini-cli", "antigravity", "codex", "claude"}


def p_should_use_external_browser(provider: str) -> bool:
    return provider in P_EXTERNAL_BROWSER_PROVIDERS


def resolve_backend_port(observed: Optional[int] = None) -> int:
    """The port this backend is actually reachable on, for building OAuth redirect URIs.

    OPENSWARM_PORT is authoritative and Electron always passes it (main.js), so packaged builds
    take the first branch and behave exactly as before.

    It is NOT always set in dev. main.py only exports it inside its `if __name__ == "__main__"`
    block, which never runs under `python -m uvicorn backend.main:app --port N`. The old code then
    assumed 8324 and stamped that into the redirect URI while uvicorn served a different port, so
    Google bounced the user to a dead port and Claude's callback missed the router rewrite. Codex
    kept working throughout, because OpenAI pins its own localhost:1455 listener, which is what
    made the failure look like "two providers are broken" instead of "the port is wrong".

    `observed` is the port the caller was actually reached on (from the live request), which is
    ground truth on every launch path. Only consulted when the env var is absent.
    """
    raw = os.environ.get("OPENSWARM_PORT")
    if raw:
        try:
            return int(raw)
        except (TypeError, ValueError):
            pass
    return observed or 8324


def callback_uri_for_provider(provider: str, backend_port: Optional[int] = None) -> str:
    """Return the redirect URI to pass to 9Router's authorize endpoint.

    Most providers accept 9Router's built-in callback page at port 20128.
    Special cases:
    - Codex/OpenAI's OAuth client is bound to a fixed
      http://localhost:1455/auth/callback URI; handled by
      p_start_codex_callback_listener above.
    - Gemini/Google's OAuth consent page rejects embedded browsers, so we
      route the callback through OpenSwarm's backend endpoint at
      /api/subscriptions/callback (backend/main.py) which runs the
      exchange itself.
    """
    if provider == "codex":
        return f"http://localhost:{P_CODEX_CALLBACK_PORT}{P_CODEX_CALLBACK_PATH}"
    # Anthropic's OAuth client only whitelists localhost:20128/callback; 9router_gpt5_patch.js 302-rewrites the hit to the backend handler.
    if provider == "claude":
        return f"http://localhost:{NINE_ROUTER_PORT}/callback"
    if provider in P_EXTERNAL_BROWSER_PROVIDERS:
        return f"http://localhost:{resolve_backend_port(backend_port)}/api/subscriptions/callback"
    return f"http://localhost:{NINE_ROUTER_PORT}/callback"


async def start_oauth(provider: str, backend_port: Optional[int] = None) -> dict:
    """Start OAuth flow for a provider.

    For device_code providers (github, qwen, kiro): returns {user_code, verification_uri, device_code}
    For authorization_code providers (claude, codex, gemini-cli): returns {authUrl, codeVerifier, state}

    `backend_port` is the port the connect request arrived on; it only matters when OPENSWARM_PORT
    is unset, which is the dev-launch case that used to send Google to a dead port.
    """
    async with httpx.AsyncClient(timeout=15.0, headers=cli_auth_headers()) as client:
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

        callback_url = callback_uri_for_provider(provider, backend_port)
        if provider == "codex":
            # Codex's redirect must be an OpenAI allow-listed loopback port; bind the first free one (1455 else 1457) and use ITS redirect_uri so authorize + token exchange agree.
            bound_port = await p_start_codex_callback_listener()
            if bound_port is None:
                raise RuntimeError(
                    "Can't start the ChatGPT login: the Codex login ports (1455 and 1457) are "
                    "both in use by another app (the Codex CLI or its VS Code extension). "
                    "Quit that app, then try again."
                )
            callback_url = f"http://localhost:{bound_port}{P_CODEX_CALLBACK_PATH}"

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
            "use_external_browser": p_should_use_external_browser(provider),
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

    async with httpx.AsyncClient(timeout=15.0, headers=cli_auth_headers()) as client:
        r = await client.post(
            f"{NINE_ROUTER_API}/oauth/{provider}/poll",
            json=body,
        )
        r.raise_for_status()
        return r.json()


async def exchange_oauth(provider: str, code: str, redirect_uri: str, code_verifier: str, state: str = "") -> dict:
    """Exchange OAuth code for tokens via 9Router."""
    async with httpx.AsyncClient(timeout=15.0, headers=cli_auth_headers()) as client:
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
