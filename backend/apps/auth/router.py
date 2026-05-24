"""Desktop-side sign-in endpoints. Mirrors openswarm-cloud/src/routes/auth/*.

The cloud handles the actual OAuth / magic-link flows. The desktop's role is
narrow: when the bearer-handoff page POSTs the token to localhost, we
validate it with the cloud (returns user_id + email + plan) and persist it
to the local settings store so subsequent requests carry the bearer.

POST /api/auth/signin-activate {token, signin_method, email?}
  Validates the bearer at cloud /api/auth/signin-activate.
  Persists user_id, user_email, signin_method, and (if a paid plan was
  returned) bearer + plan + expires.

POST /api/auth/signout
  Calls cloud /api/auth/signout to revoke the bearer, then clears local
  identity fields. Brings the user back to the sign-in gate.

POST /api/auth/identity-status {install_id?}
  Local proxy to cloud /api/me/identity-status — drives the gate's
  soft-vs-hard decision. Wraps it in our local backend so the renderer
  doesn't need to know the cloud URL.
"""

from __future__ import annotations

import json
import logging
import os
import secrets
import time
from contextlib import asynccontextmanager
from html import escape
from typing import Optional, Literal
from urllib.parse import urlencode

import httpx
from fastapi import HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from pydantic import BaseModel

from backend.config.Apps import SubApp
from backend.apps.settings.credentials import OPENSWARM_DEFAULT_PROXY_URL
from backend.apps.settings.settings import load_settings, save_settings_async

logger = logging.getLogger(__name__)

GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo"
_LOCAL_GOOGLE_STATE_TTL_SECONDS = 10 * 60
_pending_local_google_oauth: dict[str, dict[str, object]] = {}


@asynccontextmanager
async def auth_lifespan():
    yield


auth = SubApp("auth", auth_lifespan)


def _proxy_url() -> str:
    settings_obj = load_settings()
    url = (getattr(settings_obj, "openswarm_proxy_url", None)
           or OPENSWARM_DEFAULT_PROXY_URL)
    return url.rstrip("/")


def _sync_identity_to_service(settings_obj) -> None:
    """Push user_id + email + signin_method into the service-sync identify
    pipeline so every event from this user has the right Person properties."""
    try:
        from backend.apps.service.client import identify as _identify
    except Exception:
        return
    props = {
        "signin_method": getattr(settings_obj, "signin_method", None),
        "is_signed_in": bool(getattr(settings_obj, "user_id", None)),
    }
    email = getattr(settings_obj, "user_email", None)
    if email:
        props["email"] = email
    try:
        _identify(props)
    except Exception as e:
        logger.debug("identify sync failed: %s", e)


def _oauth_error_html(title: str, detail: str, *, status_code: int = 400) -> HTMLResponse:
    safe_title = escape(title)
    safe_detail = escape(detail)
    return HTMLResponse(
        "<!doctype html><html><head><meta charset='utf-8'>"
        "<title>OpenSwarm sign-in failed</title></head>"
        "<body style='font-family: system-ui, -apple-system, BlinkMacSystemFont, sans-serif; padding: 32px;'>"
        f"<h2>{safe_title}</h2><p>{safe_detail}</p>"
        "<p>You can close this tab and try signing in again from OpenSwarm.</p>"
        "</body></html>",
        status_code=status_code,
    )


def _oauth_success_html(email: str | None) -> HTMLResponse:
    payload = {
        "type": "oauth_callback",
        "data": {
            "ok": True,
            "local": True,
            "email": email,
        },
    }
    payload_json = json.dumps(payload)
    safe_email = escape(email or "your Google account")
    return HTMLResponse(
        "<!doctype html><html><head><meta charset='utf-8'>"
        "<title>Signed in to OpenSwarm</title></head>"
        "<body style='font-family: system-ui, -apple-system, BlinkMacSystemFont, sans-serif; padding: 32px;'>"
        "<h2>You're signed in</h2>"
        f"<p>OpenSwarm is now connected to {safe_email}. You can close this tab.</p>"
        "<script>"
        f"const payload = {payload_json};"
        "try { if (window.opener && !window.opener.closed) window.opener.postMessage(payload, '*'); } catch (e) {}"
        "setTimeout(function () { try { window.close(); } catch (e) {} }, 700);"
        "</script>"
        "</body></html>",
    )


def _prune_local_google_states() -> None:
    now = time.time()
    expired = [
        state for state, value in _pending_local_google_oauth.items()
        if float(value.get("expires_at", 0)) <= now
    ]
    for state in expired:
        _pending_local_google_oauth.pop(state, None)


def _local_oauth_port(request: Request, local_port: Optional[int]) -> int:
    if isinstance(local_port, int) and 1 <= local_port <= 65535:
        return local_port
    if request.url.port:
        return int(request.url.port)
    raw = os.environ.get("OPENSWARM_PORT") or os.environ.get("BACKEND_PORT") or "8324"
    try:
        port = int(raw)
        if 1 <= port <= 65535:
            return port
    except ValueError:
        pass
    return 8324


# ---------------------------------------------------------------------------
# GET /api/auth/browser-token
# ---------------------------------------------------------------------------

@auth.router.get("/browser-token")
async def browser_token(request: Request):
    """Return the localhost API bearer to the first-party browser frontend.

    Electron does not use this; it still reads the token through the preload
    bridge. Plain browser mode cannot read AUTH_TOKEN_FILE, so without this
    bootstrap it loops on 401 for /api/settings before the sign-in gate can
    finish. The route is intentionally limited to loopback hosts and
    first-party localhost dev origins.
    """
    from backend.auth import get_auth_token

    origin = request.headers.get("origin") or ""
    host = request.headers.get("host") or ""
    allowed_origin = origin in {
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    }
    allowed_host = host.startswith("localhost:") or host.startswith("127.0.0.1:")
    if not allowed_origin or not allowed_host:
        raise HTTPException(status_code=403, detail="Browser token is only available to localhost dev frontend")
    token = get_auth_token()
    if not token:
        raise HTTPException(status_code=503, detail="Auth token has not been initialized")
    return {"token": token}


# ---------------------------------------------------------------------------
# Browser-only local Google OAuth fallback
# ---------------------------------------------------------------------------

@auth.router.get("/google/start")
async def google_start(request: Request, install_id: Optional[str] = None, local_port: Optional[int] = None):
    """Start Google sign-in without the Electron deep-link handoff.

    Electron continues to use api.openswarm.com's /api/auth/google/start flow,
    which finishes through openswarm:// and the preload bridge. Plain browser
    runs do not have that bridge, so the frontend opens this localhost route
    instead; Google redirects back to /api/auth/google/callback and we persist
    the signed-in identity locally.
    """
    client_id = os.environ.get("GOOGLE_OAUTH_CLIENT_ID", "").strip()
    client_secret = os.environ.get("GOOGLE_OAUTH_CLIENT_SECRET", "").strip()
    if not client_id or not client_secret:
        return _oauth_error_html(
            "Google sign-in is not configured",
            "Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in backend/.env, "
            "then restart the backend. Electron sign-in is unaffected and still uses the cloud handoff.",
            status_code=503,
        )

    _prune_local_google_states()
    port = _local_oauth_port(request, local_port)
    redirect_uri = f"http://localhost:{port}/api/auth/google/callback"
    state = secrets.token_urlsafe(24)
    _pending_local_google_oauth[state] = {
        "expires_at": time.time() + _LOCAL_GOOGLE_STATE_TTL_SECONDS,
        "redirect_uri": redirect_uri,
        "install_id": install_id or "",
    }
    params = {
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": "openid email profile",
        "state": state,
        "access_type": "online",
        "prompt": "select_account",
    }
    return RedirectResponse(f"{GOOGLE_AUTH_URL}?{urlencode(params)}", status_code=302)


@auth.router.get("/google/callback")
async def google_callback(code: Optional[str] = None, state: Optional[str] = None, error: Optional[str] = None):
    if error:
        return _oauth_error_html("Google sign-in was cancelled", error, status_code=400)
    if not code or not state:
        return _oauth_error_html("Missing OAuth callback fields", "Google did not return the expected code/state.")

    _prune_local_google_states()
    pending = _pending_local_google_oauth.pop(state, None)
    if not pending:
        return _oauth_error_html("Sign-in session expired", "Please start Google sign-in again from OpenSwarm.", status_code=410)
    redirect_uri = str(pending.get("redirect_uri") or "")
    if not redirect_uri:
        return _oauth_error_html("Invalid sign-in session", "The callback URI was not recorded.")

    client_id = os.environ.get("GOOGLE_OAUTH_CLIENT_ID", "").strip()
    client_secret = os.environ.get("GOOGLE_OAUTH_CLIENT_SECRET", "").strip()
    if not client_id or not client_secret:
        return _oauth_error_html("Google sign-in is not configured", "Missing Google OAuth credentials.", status_code=503)

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            token_resp = await client.post(
                GOOGLE_TOKEN_URL,
                data={
                    "code": code,
                    "client_id": client_id,
                    "client_secret": client_secret,
                    "redirect_uri": redirect_uri,
                    "grant_type": "authorization_code",
                },
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
            if token_resp.status_code != 200:
                logger.warning("local Google token exchange failed: HTTP %d %s", token_resp.status_code, token_resp.text[:200])
                return _oauth_error_html("Google token exchange failed", token_resp.text[:300], status_code=502)
            access_token = (token_resp.json() or {}).get("access_token")
            if not access_token:
                return _oauth_error_html("Google token exchange failed", "Google did not return an access token.", status_code=502)
            info_resp = await client.get(
                GOOGLE_USERINFO_URL,
                headers={"Authorization": f"Bearer {access_token}"},
            )
            if info_resp.status_code != 200:
                logger.warning("local Google userinfo failed: HTTP %d %s", info_resp.status_code, info_resp.text[:200])
                return _oauth_error_html("Could not read Google profile", info_resp.text[:300], status_code=502)
            profile = info_resp.json() or {}
    except httpx.HTTPError as e:
        logger.warning("local Google OAuth failed: %s", e)
        return _oauth_error_html("Google sign-in failed", str(e), status_code=502)

    google_sub = str(profile.get("id") or profile.get("sub") or "").strip()
    email = str(profile.get("email") or "").strip() or None
    if not google_sub and not email:
        return _oauth_error_html("Google profile was incomplete", "No account id or email was returned.", status_code=502)

    settings_obj = load_settings()
    settings_obj.user_id = f"google:{google_sub or email}"
    settings_obj.user_email = email
    settings_obj.signin_method = "google"
    settings_obj.openswarm_proxy_url = _proxy_url()
    await save_settings_async(settings_obj)
    _sync_identity_to_service(settings_obj)
    return _oauth_success_html(email)


# ---------------------------------------------------------------------------
# POST /api/auth/signin-activate
# ---------------------------------------------------------------------------

class SigninActivateRequest(BaseModel):
    token: str
    signin_method: Literal["google", "email"]
    email: Optional[str] = None


@auth.router.post("/signin-activate")
async def signin_activate(body: SigninActivateRequest):
    """Validate a freshly-minted sign-in bearer and persist it locally.

    The bearer-handoff page (cloud lib/authMint.ts → bearerHandoffPage())
    POSTs to this endpoint after a Google OAuth or magic-link flow. We
    re-validate the bearer with the cloud — never just trust whatever
    arrives at the localhost endpoint — then write user_id + email +
    signin_method to settings so the renderer can dismiss the gate.
    """
    if not body.token or len(body.token) < 16:
        raise HTTPException(status_code=400, detail="Invalid token")

    proxy = _proxy_url()
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.post(
                f"{proxy}/api/auth/signin-activate",
                json={
                    "token": body.token,
                    "signin_method": body.signin_method,
                    "email": body.email,
                },
            )
    except httpx.HTTPError as e:
        raise HTTPException(
            status_code=502,
            detail=f"Could not reach sign-in service: {e}",
        )

    if r.status_code == 401:
        raise HTTPException(status_code=401, detail="Token rejected by service")
    if r.status_code >= 400:
        raise HTTPException(
            status_code=r.status_code,
            detail=r.text[:200] or "Service error",
        )

    me = r.json()
    user_id = me.get("user_id")
    email = me.get("email")
    plan = me.get("plan")
    expires = me.get("expires")
    method = me.get("signin_method") or body.signin_method

    settings_obj = load_settings()
    settings_obj.user_id = user_id
    settings_obj.user_email = email
    settings_obj.signin_method = method
    # If the user happens to be a paying customer too (Stripe + sign-in
    # share a user row by email), surface plan/expires so the chat picker
    # exposes Pro models. Free-tier signups land here with plan="free"
    # and expires=null — connection_mode stays own_key.
    if isinstance(plan, str) and plan != "free":
        settings_obj.connection_mode = "openswarm-pro"
        settings_obj.openswarm_bearer_token = body.token
        settings_obj.openswarm_proxy_url = proxy
        settings_obj.openswarm_subscription_plan = plan
        if isinstance(expires, str):
            settings_obj.openswarm_subscription_expires = expires
    else:
        # Free-tier: still store the bearer so future API calls can identify
        # the user (used by /api/me/profile, /api/auth/signout). Do NOT flip
        # connection_mode — that's reserved for paid plans only so chat
        # routing keeps using own_key/BYO.
        settings_obj.openswarm_bearer_token = body.token
        settings_obj.openswarm_proxy_url = proxy

    await save_settings_async(settings_obj)
    _sync_identity_to_service(settings_obj)

    return {
        "ok": True,
        "user_id": user_id,
        "email": email,
        "plan": plan or "free",
        "signin_method": method,
    }


# ---------------------------------------------------------------------------
# POST /api/auth/signout
# ---------------------------------------------------------------------------

@auth.router.post("/signout")
async def signout():
    """Revoke the cloud-side bearer + clear local identity state.

    Also stops every in-flight agent session so any 9Router subprocess
    that captured the now-revoked bearer at spawn time can't keep using
    it. Without this, a signed-out user's old chat tabs would keep
    making /v1/messages calls with a token the cloud has revoked,
    surfacing as 401s in the agent UI ("Invalid bearer token").
    """
    settings_obj = load_settings()
    bearer = getattr(settings_obj, "openswarm_bearer_token", None)
    proxy = _proxy_url()
    if bearer:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                await client.post(
                    f"{proxy}/api/auth/signout",
                    headers={"Authorization": f"Bearer {bearer}"},
                )
        except httpx.HTTPError as e:
            # Network failure shouldn't strand the user signed-in locally;
            # the cloud token is invalidated lazily on next use anyway.
            logger.warning("cloud signout failed (clearing local anyway): %s", e)

    # Stop every running agent session AND drop their cached SDK resume
    # state BEFORE clearing local settings. Two failure modes this prevents:
    #   1. A 9Router subprocess captured the now-revoked bearer at spawn
    #      time and would 401 on the next /v1/messages call.
    #   2. A session has an `sdk_session_id` from a conversation served by
    #      the previous identity's Claude account; resuming against the new
    #      bearer would 404 or 401 because the new account has no record
    #      of that thread. Wiping it forces the SDK to start a fresh thread
    #      on next send (transcript replay still works — only the SDK's
    #      server-side resume cache is reset).
    # Best-effort: failures here shouldn't block the sign-out itself.
    try:
        from backend.apps.agents.agent_manager import agent_manager
        from backend.apps.agents.agent_manager import _save_session

        running = list(agent_manager.tasks.keys())
        for session_id in running:
            try:
                await agent_manager.stop_agent(session_id)
            except Exception as e:
                logger.warning("signout: stop_agent(%s) failed: %s", session_id, e)

        # Walk every loaded session (running, stopped, persisted-but-resumed)
        # and clear the SDK resume id so the next send starts a fresh thread
        # under whichever identity the user re-signs-in with.
        for sess in list(agent_manager.sessions.values()):
            if sess.sdk_session_id:
                sess.sdk_session_id = None
                try:
                    _save_session(sess.id, sess.model_dump(mode="json"))
                except Exception as e:
                    logger.warning("signout: save_session(%s) failed: %s", sess.id, e)

        if running:
            logger.info("signout: stopped %d in-flight agent session(s)", len(running))
    except Exception as e:
        logger.warning("signout: agent shutdown skipped: %s", e)

    settings_obj.user_id = None
    settings_obj.user_email = None
    settings_obj.signin_method = None
    settings_obj.openswarm_bearer_token = None
    settings_obj.connection_mode = "own_key"
    settings_obj.openswarm_subscription_plan = None
    settings_obj.openswarm_subscription_expires = None
    settings_obj.openswarm_usage_cached = None
    await save_settings_async(settings_obj)
    _sync_identity_to_service(settings_obj)
    return {"ok": True}


# ---------------------------------------------------------------------------
# GET /api/auth/identity-status
# ---------------------------------------------------------------------------

@auth.router.get("/identity-status")
async def identity_status():
    """Returns gate-state for the renderer.

    The renderer's SignInGateLoader calls this on mount to decide between
    soft gate (banner) vs hard gate (modal). Local-side authoritative
    field is settings.user_id; the cloud answers install age + grace
    deadline.
    """
    settings_obj = load_settings()
    user_id = getattr(settings_obj, "user_id", None)
    if user_id:
        return {
            "authed": True,
            "user_id": user_id,
            "email": getattr(settings_obj, "user_email", None),
            "signin_method": getattr(settings_obj, "signin_method", None),
            "hard_gate": False,
        }

    # Not signed in — defer to cloud for install-age + grace-window math.
    install_id = getattr(settings_obj, "installation_id", None)
    if not install_id:
        # No install_id yet (very fresh install before first sync) — hard gate.
        return {"authed": False, "hard_gate": True, "install_age_days": 0, "deadline_ts": None}

    proxy = _proxy_url()
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.get(
                f"{proxy}/api/me/identity-status",
                params={"install_id": install_id},
            )
        if r.status_code == 200:
            data = r.json()
            return {
                "authed": False,
                "hard_gate": bool(data.get("hard_gate", True)),
                "install_age_days": int(data.get("install_age_days", 0)),
                "deadline_ts": data.get("deadline_ts"),
            }
    except httpx.HTTPError as e:
        logger.debug("identity-status cloud fetch failed: %s", e)

    # Cloud unreachable — fail open with soft gate so a flaky network
    # doesn't lock the user out. Renderer will retry on next mount.
    return {"authed": False, "hard_gate": False, "install_age_days": 0, "deadline_ts": None}
