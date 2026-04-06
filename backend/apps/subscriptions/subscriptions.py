"""Subscription management sub-app.

Manages the 9Router subprocess lifecycle and exposes REST endpoints
for the frontend to connect/disconnect subscription providers
(Claude, ChatGPT, Gemini, etc.) via OAuth.
"""

import asyncio

import httpx
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse

from backend.config.Apps import SubApp
from backend.apps.subscriptions.NineRouter.NineRouterProcess import (
    is_running, ensure_running, stop,
)
from backend.apps.subscriptions.NineRouter.NineRouterClient import (
    get_providers, get_models, start_oauth, poll_oauth, exchange_oauth,
    NINE_ROUTER_API,
)
from backend.apps.subscriptions.html_constants import SUCCESS_HTML, ERROR_STYLE
from typing import Dict

P_PENDING_OAUTH: Dict[str, dict] = {}
P_ENSURE_TASK: Optional[asyncio.Task] = None

# ---------------------------------------------------------------------------
# Lifespan
# ---------------------------------------------------------------------------

@asynccontextmanager
async def subscriptions_lifespan():
    try:
        await ensure_running()
    except Exception as e:
        print(f"9Router auto-start failed: {e}")
    yield
    global P_ENSURE_TASK
    if P_ENSURE_TASK and not P_ENSURE_TASK.done():
        P_ENSURE_TASK.cancel()
    try:
        stop()
    except Exception:
        pass


subscriptions = SubApp("subscriptions", subscriptions_lifespan)


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@subscriptions.router.get("/status")
async def subscriptions_status() -> dict:
    global P_ENSURE_TASK
    if not is_running():
        if P_ENSURE_TASK is None or P_ENSURE_TASK.done():
            P_ENSURE_TASK = asyncio.create_task(ensure_running())
        return {"running": False, "providers": [], "models": []}
    providers = await get_providers()
    models = await get_models()
    return {"running": True, "providers": providers, "models": models}


@subscriptions.router.post("/connect")
async def subscriptions_connect(body: dict) -> dict:
    provider: str = body.get("provider", "")
    if not provider:
        raise HTTPException(status_code=400, detail="provider required")

    if not is_running():
        await ensure_running()
        if not is_running():
            raise HTTPException(status_code=503, detail="9Router not available. Please install Node.js.")

    try:
        result: dict = await start_oauth(provider)
        if result.get("flow") == "authorization_code" and result.get("state"):
            P_PENDING_OAUTH[result["state"]] = {
                "provider": provider,
                "code_verifier": result.get("code_verifier", ""),
                "redirect_uri": result.get("redirect_uri", ""),
            }
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@subscriptions.router.post("/poll")
async def subscriptions_poll(body: dict) -> dict:
    provider: str = body.get("provider", "")
    device_code: str = body.get("device_code", "")
    if not provider or not device_code:
        raise HTTPException(status_code=400, detail="provider and device_code required")

    try:
        result: dict = await poll_oauth(
            provider, device_code,
            code_verifier=body.get("code_verifier"),
            extra_data=body.get("extra_data"),
        )
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@subscriptions.router.post("/disconnect")
async def subscriptions_disconnect(body: dict) -> dict:
    provider: str = body.get("provider", "")
    if not provider:
        raise HTTPException(status_code=400, detail="provider required")

    try:
        providers_data = await get_providers()
        connections: list = providers_data.get("connections", []) if isinstance(providers_data, dict) else []
        conn = next((c for c in connections if c.get("provider") == provider), None)
        if conn and conn.get("id"):
            async with httpx.AsyncClient(timeout=10.0) as client:
                await client.delete(f"{NINE_ROUTER_API}/providers/{conn['id']}")
            return {"ok": True}
        return {"ok": False, "error": "Connection not found"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@subscriptions.router.get("/pending/{state}")
async def subscriptions_pending(state: str):
    pending: Optional[dict] = P_PENDING_OAUTH.get(state)
    if not pending:
        return JSONResponse(
            {"error": "not found"}, status_code=404,
            headers={"Access-Control-Allow-Origin": "*"},
        )
    return JSONResponse({
        "provider": pending["provider"],
        "code_verifier": pending["code_verifier"],
        "redirect_uri": pending["redirect_uri"],
    }, headers={"Access-Control-Allow-Origin": "*"})


@subscriptions.router.get("/callback")
async def subscriptions_callback(request: Request):
    code: str = request.query_params.get("code", "")
    state: str = request.query_params.get("state", "")
    error: str = request.query_params.get("error", "")

    if error:
        desc: str = request.query_params.get("error_description", error)
        return HTMLResponse(
            f'<html><body {ERROR_STYLE}><div style="text-align:center">'
            f'<h2>Authorization failed</h2><p style="color:#888">{desc}</p></div></body></html>'
        )

    pending: Optional[dict] = P_PENDING_OAUTH.pop(state, None)
    if not pending:
        return HTMLResponse(
            f'<html><body {ERROR_STYLE}><div style="text-align:center">'
            f'<h2>Session expired</h2><p style="color:#888">Please try connecting again.</p></div></body></html>'
        )

    try:
        await exchange_oauth(
            pending["provider"], code,
            pending["redirect_uri"], pending["code_verifier"], state,
        )
    except Exception as e:
        print(f"OAuth callback: exchange failed for provider={pending['provider']}: {e}")
        return HTMLResponse(
            f'<html><body {ERROR_STYLE}><div style="text-align:center">'
            f'<h2>Connection failed</h2><p style="color:#888">{e}</p></div></body></html>'
        )

    return HTMLResponse(SUCCESS_HTML)
