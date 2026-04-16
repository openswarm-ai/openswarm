"""Desktop-side subscription endpoints."""

from __future__ import annotations

import json
import logging
import os
from contextlib import asynccontextmanager
from typing import Optional

import httpx
from fastapi import HTTPException
from pydantic import BaseModel

from backend.config.Apps import SubApp
from backend.apps.settings.credentials import OPENSWARM_DEFAULT_PROXY_URL
from backend.apps.settings.settings import SETTINGS_FILE, load_settings

logger = logging.getLogger(__name__)


@asynccontextmanager
async def subscription_lifespan():
    yield


subscription = SubApp("subscription", subscription_lifespan)


def _proxy_url() -> str:
    """Cloud router base URL. Overridable per-user via settings, falling back
    to the module-default. No trailing slash."""
    settings_obj = load_settings()
    url = (getattr(settings_obj, "openswarm_proxy_url", None)
           or OPENSWARM_DEFAULT_PROXY_URL)
    return url.rstrip("/")


def _write_settings(settings_obj) -> None:
    """Persist AppSettings to disk. Mirrors backend/apps/settings/settings.py
    _save_settings to avoid importing a private module member."""
    os.makedirs(os.path.dirname(SETTINGS_FILE), exist_ok=True)
    with open(SETTINGS_FILE, "w") as f:
        json.dump(settings_obj.model_dump(), f, indent=2)


# ---------------------------------------------------------------------------
# POST /api/subscription/activate
# ---------------------------------------------------------------------------

class ActivateRequest(BaseModel):
    token: str
    plan: Optional[str] = None
    expires: Optional[str] = None  # ISO 8601


@subscription.router.post("/activate")
async def activate(body: ActivateRequest):
    """Renderer calls this after catching an openswarm://auth deep link.

    Validates the bearer by calling the cloud /api/me, then persists it to
    settings. On success the desktop app flips into openswarm-pro mode for
    subsequent Claude requests.
    """
    if not body.token or len(body.token) < 16:
        raise HTTPException(status_code=400, detail="Invalid token")

    proxy = _proxy_url()
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.get(
                f"{proxy}/api/me",
                headers={"Authorization": f"Bearer {body.token}"},
            )
    except httpx.HTTPError as e:
        raise HTTPException(
            status_code=502,
            detail=f"Could not reach subscription service: {e}",
        )

    if r.status_code == 401:
        raise HTTPException(status_code=401, detail="Token rejected by service")
    if r.status_code >= 400:
        raise HTTPException(
            status_code=r.status_code,
            detail=r.text[:200] or "Service error",
        )

    me = r.json()

    # Persist to settings. Prefer cloud-reported values; fall back to the
    # deep-link's own fields if cloud is sparse.
    settings_obj = load_settings()
    settings_obj.connection_mode = "openswarm-pro"
    settings_obj.openswarm_bearer_token = body.token
    settings_obj.openswarm_proxy_url = proxy
    settings_obj.openswarm_subscription_plan = (
        me.get("plan") or body.plan or "pro"
    )
    period_end = me.get("current_period_end")
    if isinstance(period_end, (int, float)):
        # cloud returns unix ms
        from datetime import datetime, timezone
        settings_obj.openswarm_subscription_expires = (
            datetime.fromtimestamp(period_end / 1000, tz=timezone.utc).isoformat()
        )
    elif body.expires:
        settings_obj.openswarm_subscription_expires = body.expires

    usage = me.get("usage")
    if isinstance(usage, dict):
        settings_obj.openswarm_usage_cached = usage

    _write_settings(settings_obj)
    return {"ok": True, "plan": settings_obj.openswarm_subscription_plan}


# ---------------------------------------------------------------------------
# GET /api/subscription/status
# ---------------------------------------------------------------------------

@subscription.router.get("/status")
async def status():
    """Consolidated view for the Settings card. Reads persisted plan/expires,
    polls cloud for live usage when a bearer is present."""
    settings_obj = load_settings()
    bearer = getattr(settings_obj, "openswarm_bearer_token", None)
    plan = getattr(settings_obj, "openswarm_subscription_plan", None)
    expires = getattr(settings_obj, "openswarm_subscription_expires", None)
    mode = getattr(settings_obj, "connection_mode", "own_key")

    if mode != "openswarm-pro" or not bearer:
        return {
            "connected": False,
            "connection_mode": mode,
        }

    # Best-effort live fetch — surface stale cache if cloud is unreachable.
    live_usage = None
    live_status = None
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.get(
                f"{_proxy_url()}/api/me",
                headers={"Authorization": f"Bearer {bearer}"},
            )
        if r.status_code == 200:
            me = r.json()
            live_usage = me.get("usage")
            live_status = me.get("status")
            # Update cache for offline display.
            if isinstance(live_usage, dict):
                settings_obj.openswarm_usage_cached = live_usage
                _write_settings(settings_obj)
    except httpx.HTTPError as e:
        logger.debug("subscription/status live fetch failed: %s", e)

    return {
        "connected": True,
        "connection_mode": mode,
        "plan": plan,
        "status": live_status or "active",
        "expires": expires,
        "usage": live_usage or getattr(settings_obj, "openswarm_usage_cached", None),
    }


# ---------------------------------------------------------------------------
# POST /api/subscription/portal
# ---------------------------------------------------------------------------

@subscription.router.post("/portal")
async def portal():
    """Returns a Stripe Customer Portal URL. Renderer opens it in the
    system browser via shell.openExternal."""
    settings_obj = load_settings()
    bearer = getattr(settings_obj, "openswarm_bearer_token", None)
    if not bearer:
        raise HTTPException(status_code=400, detail="Not subscribed")

    async with httpx.AsyncClient(timeout=10.0) as client:
        r = await client.post(
            f"{_proxy_url()}/api/billing/portal",
            headers={"Authorization": f"Bearer {bearer}"},
        )
    if r.status_code >= 400:
        raise HTTPException(status_code=r.status_code, detail=r.text[:200])
    data = r.json()
    return {"url": data.get("url")}


# ---------------------------------------------------------------------------
# POST /api/subscription/disconnect
# ---------------------------------------------------------------------------

@subscription.router.post("/disconnect")
async def disconnect():
    """Clears local bearer + reverts to own_key mode. Does NOT cancel the
    Stripe subscription (use the portal for that). Useful when a user wants
    to temporarily route through their own API key."""
    settings_obj = load_settings()
    settings_obj.connection_mode = "own_key"
    settings_obj.openswarm_bearer_token = None
    settings_obj.openswarm_subscription_plan = None
    settings_obj.openswarm_subscription_expires = None
    settings_obj.openswarm_usage_cached = None
    _write_settings(settings_obj)
    return {"ok": True}
