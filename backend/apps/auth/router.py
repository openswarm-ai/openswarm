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
  identity fields.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import Optional, Literal

import httpx
from fastapi import HTTPException
from pydantic import BaseModel

from backend.config.Apps import SubApp
from backend.apps.settings.credentials import OPENSWARM_DEFAULT_PROXY_URL
from backend.apps.settings.settings import load_settings, save_settings_async

logger = logging.getLogger(__name__)


@asynccontextmanager
async def auth_lifespan():
    yield


auth = SubApp("auth", auth_lifespan)


def p_proxy_url() -> str:
    settings_obj = load_settings()
    url = (getattr(settings_obj, "openswarm_proxy_url", None)
           or OPENSWARM_DEFAULT_PROXY_URL)
    return url.rstrip("/")


async def p_sync_pro_routing(settings_obj) -> None:
    """Mirror connection state into 9Router's Claude lane; sign-in can flip a
    paying user into pro mode and sign-out must tear the lane down so a
    revoked bearer doesn't linger in the router."""
    try:
        from backend.apps.nine_router import sync_pro_routing
        await sync_pro_routing(settings_obj)
    except Exception as e:
        logger.debug("pro routing sync skipped: %s", e)


def p_sync_identity_to_service(settings_obj) -> None:
    """Push user_id + email + signin_method into the service-sync identify
    pipeline so every event from this user has the right Person properties."""
    try:
        from backend.apps.service.client import identify as p_identify
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
        p_identify(props)
    except Exception as e:
        logger.debug("identify sync failed: %s", e)
    if email:
        try:
            from backend.apps.service.analytics.client import track_link_email
            track_link_email(email)
        except Exception as e:
            logger.debug("analytics link_email sync failed: %s", e)


# --------------------------------------------------------------------------- POST /api/auth/signin-activate ---------------------------------------------------------------------------

class SigninActivateRequest(BaseModel):
    token: str
    signin_method: Literal["google", "email"]
    email: Optional[str] = None


@auth.router.post("/signin-activate")
async def signin_activate(body: SigninActivateRequest):
    """Validate a freshly-minted sign-in bearer and persist it locally.

    The bearer-handoff page (cloud lib/authMint.ts → bearerHandoffPage())
    POSTs to this endpoint after a Google OAuth or magic-link flow. We
    re-validate the bearer with the cloud; never just trust whatever
    arrives at the localhost endpoint; then write user_id + email +
    signin_method to settings so the renderer flips to signed-in.
    """
    if not body.token or len(body.token) < 16:
        raise HTTPException(status_code=400, detail="Invalid token")

    proxy = p_proxy_url()
    payload = {
        "token": body.token,
        "signin_method": body.signin_method,
        "email": body.email,
    }
    p_install_id = getattr(load_settings(), "installation_id", None)
    if p_install_id:
        payload["install_id"] = p_install_id
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.post(
                f"{proxy}/api/auth/signin-activate",
                json=payload,
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
    # If the user happens to be a paying customer too (Stripe + sign-in share a user row by email), surface plan/expires so the chat picker exposes Pro models. Free-tier signups land here with plan="free" and expires=null; connection_mode stays own_key.
    if isinstance(plan, str) and plan != "free":
        settings_obj.connection_mode = "openswarm-pro"
        settings_obj.openswarm_bearer_token = body.token
        settings_obj.openswarm_proxy_url = proxy
        settings_obj.openswarm_subscription_plan = plan
        if isinstance(expires, str):
            settings_obj.openswarm_subscription_expires = expires
    else:
        # Free-tier: still store the bearer so future API calls can identify the user (used by /api/me/profile, /api/auth/signout). Do NOT flip connection_mode; that's reserved for paid plans only so chat routing keeps using own_key/BYO.
        settings_obj.openswarm_bearer_token = body.token
        settings_obj.openswarm_proxy_url = proxy

    await save_settings_async(settings_obj)
    p_sync_identity_to_service(settings_obj)
    await p_sync_pro_routing(settings_obj)

    return {
        "ok": True,
        "user_id": user_id,
        "email": email,
        "plan": plan or "free",
        "signin_method": method,
    }


# --------------------------------------------------------------------------- POST /api/auth/signout ---------------------------------------------------------------------------

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
    proxy = p_proxy_url()
    if bearer:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                await client.post(
                    f"{proxy}/api/auth/signout",
                    headers={"Authorization": f"Bearer {bearer}"},
                )
        except httpx.HTTPError as e:
            # Network failure shouldn't strand the user signed-in locally; the cloud token is invalidated lazily on next use anyway.
            logger.warning("cloud signout failed (clearing local anyway): %s", e)

    # Stop every running agent session AND drop their cached SDK resume state BEFORE clearing local settings. Two failure modes this prevents: 1. A 9Router subprocess captured the now-revoked bearer at spawn time and would 401 on the next /v1/messages call. 2. A session has an `sdk_session_id` from a conversation served by the previous identity's Claude account; resuming against the new bearer would 404 or 401 because the new account has no record of that thread. Wiping it forces the SDK to start a fresh thread on next send (transcript replay still works; only the SDK's server-side resume cache is reset). Best-effort: failures here shouldn't block the sign-out itself.
    try:
        from backend.apps.agents.agent_manager import agent_manager
        from backend.apps.agents.manager.session.session_store import save_session

        running = list(agent_manager.tasks.keys())
        for session_id in running:
            try:
                await agent_manager.stop_agent(session_id)
            except Exception as e:
                logger.warning("signout: stop_agent(%s) failed: %s", session_id, e)

        # Walk every loaded session (running, stopped, persisted-but-resumed) and clear the SDK resume id so the next send starts a fresh thread under whichever identity the user re-signs-in with.
        for sess in list(agent_manager.sessions.values()):
            if sess.sdk_session_id:
                sess.sdk_session_id = None
                try:
                    save_session(sess.id, sess.model_dump(mode="json"))
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
    p_sync_identity_to_service(settings_obj)
    await p_sync_pro_routing(settings_obj)
    return {"ok": True}
