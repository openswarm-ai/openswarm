"""9Router / subscription management endpoints.

Moved from agents.py and main.py to a dedicated sub-app.
"""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse, HTMLResponse

from backend.config.Apps import SubApp

logger = logging.getLogger(__name__)

_pending_oauth: dict[str, dict] = {}
_ensure_task: asyncio.Task | None = None


@asynccontextmanager
async def subscriptions_lifespan():
    logger.info("Subscriptions sub-app starting")
    yield
    global _ensure_task
    if _ensure_task and not _ensure_task.done():
        _ensure_task.cancel()
    logger.info("Subscriptions sub-app shutting down")


subscriptions = SubApp("subscriptions", subscriptions_lifespan)


@subscriptions.router.get("/status")
async def subscriptions_status():
    """Check if 9Router is running and list connected providers."""
    global _ensure_task
    from backend.apps.nine_router import is_running, ensure_running, get_providers, get_models
    if not is_running():
        if _ensure_task is None or _ensure_task.done():
            _ensure_task = asyncio.create_task(ensure_running())
        return {"running": False, "providers": [], "models": []}
    providers = await get_providers()
    models = await get_models()
    return {"running": True, "providers": providers, "models": models}


@subscriptions.router.post("/connect")
async def subscriptions_connect(body: dict):
    """Start OAuth flow for a subscription provider."""
    from backend.apps.nine_router import is_running, ensure_running, start_oauth
    provider = body.get("provider", "")
    if not provider:
        raise HTTPException(status_code=400, detail="provider required")

    if not is_running():
        await ensure_running()
        if not is_running():
            raise HTTPException(status_code=503, detail="9Router not available. Please install Node.js.")

    try:
        result = await start_oauth(provider)
        if result.get("flow") == "authorization_code" and result.get("state"):
            _pending_oauth[result["state"]] = {
                "provider": provider,
                "code_verifier": result.get("code_verifier", ""),
                "redirect_uri": result.get("redirect_uri", ""),
            }
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@subscriptions.router.post("/poll")
async def subscriptions_poll(body: dict):
    """Poll for OAuth completion."""
    from backend.apps.nine_router import poll_oauth
    provider = body.get("provider", "")
    device_code = body.get("device_code", "")
    if not provider or not device_code:
        raise HTTPException(status_code=400, detail="provider and device_code required")

    try:
        result = await poll_oauth(
            provider, device_code,
            code_verifier=body.get("code_verifier"),
            extra_data=body.get("extra_data"),
        )
        if result.get("success"):
            from backend.apps.analytics.collector import record as _analytics
            _analytics("subscription.connected", {"provider": provider})
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@subscriptions.router.post("/disconnect")
async def subscriptions_disconnect(body: dict):
    """Disconnect a subscription provider via 9Router."""
    import httpx
    provider = body.get("provider", "")
    if not provider:
        raise HTTPException(status_code=400, detail="provider required")

    try:
        from backend.apps.nine_router import NINE_ROUTER_API, get_providers
        providers_data = await get_providers()
        connections = providers_data.get("connections", []) if isinstance(providers_data, dict) else []
        conn = next((c for c in connections if c.get("provider") == provider), None)
        if conn and conn.get("id"):
            async with httpx.AsyncClient(timeout=10.0) as client:
                await client.delete(f"{NINE_ROUTER_API}/providers/{conn['id']}")
            from backend.apps.analytics.collector import record as _analytics
            _analytics("subscription.disconnected", {"provider": provider})
            return {"ok": True}
        return {"ok": False, "error": "Connection not found"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@subscriptions.router.get("/pending/{state}")
async def subscriptions_pending(state: str):
    """Return pending OAuth data for a state param. Called by 9Router's callback page."""
    pending = _pending_oauth.get(state)
    if not pending:
        return JSONResponse({"error": "not found"}, status_code=404,
                           headers={"Access-Control-Allow-Origin": "*"})
    return JSONResponse({
        "provider": pending["provider"],
        "code_verifier": pending["code_verifier"],
        "redirect_uri": pending["redirect_uri"],
    }, headers={"Access-Control-Allow-Origin": "*"})


@subscriptions.router.get("/callback")
async def subscriptions_callback(request: Request):
    """Catch OAuth redirect from provider, exchange code via 9Router, close window."""
    code = request.query_params.get("code", "")
    state = request.query_params.get("state", "")
    error = request.query_params.get("error", "")

    if error:
        desc = request.query_params.get("error_description", error)
        return HTMLResponse(f'<html><body style="background:#1a1a1a;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif"><div style="text-align:center"><h2>Authorization failed</h2><p style="color:#888">{desc}</p></div></body></html>')

    pending = _pending_oauth.pop(state, None)
    if not pending:
        return HTMLResponse('<html><body style="background:#1a1a1a;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif"><div style="text-align:center"><h2>Session expired</h2><p style="color:#888">Please try connecting again.</p></div></body></html>')

    from backend.apps.nine_router import exchange_oauth
    try:
        logger.info(f"OAuth callback: exchanging code for provider={pending['provider']}")
        result = await exchange_oauth(pending["provider"], code, pending["redirect_uri"], pending["code_verifier"], state)
        logger.info(f"OAuth callback: exchange result success={result.get('success')}")
    except Exception as e:
        logger.error(f"OAuth callback: exchange failed for provider={pending['provider']}: {e}")
        return HTMLResponse(f'<html><body style="background:#1a1a1a;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif"><div style="text-align:center"><h2>Connection failed</h2><p style="color:#888">{e}</p></div></body></html>')

    from backend.apps.analytics.collector import record as _analytics
    _analytics("subscription.connected", {"provider": pending["provider"]})

    return HTMLResponse(
        '<html><body style="background:#1a1a1a;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif">'
        '<div style="text-align:center">'
        '<div style="width:64px;height:64px;border-radius:50%;background:#22c55e20;display:flex;align-items:center;justify-content:center;margin:0 auto 16px;font-size:32px">&#10003;</div>'
        '<h2 style="margin:0 0 8px">Connected!</h2>'
        '<p style="color:#888;margin:0">You can close this window</p>'
        '</div>'
        '<script>'
        'try{if(window.opener)window.opener.postMessage({type:"oauth_callback",data:{connected:true}},"*")}catch(e){}'
        'setTimeout(()=>window.close(),1500)'
        '</script>'
        '</body></html>'
    )
