"""Subscription management sub-app.

Manages the 9Router subprocess lifecycle and exposes REST endpoints
for the frontend to connect/disconnect subscription providers
(Claude, ChatGPT, Gemini, etc.) via OAuth.
"""

from contextlib import asynccontextmanager
from typing import Dict, Optional

from fastapi import HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse

from backend.config.Apps import SubApp
from backend.apps.subscriptions.NineRouter.NineRouter import NineRouter
from backend.apps.subscriptions.html_constants import SUCCESS_HTML, ERROR_STYLE
from swarm_debug import debug

P_PENDING_OAUTH: Dict[str, dict] = {}

# ---------------------------------------------------------------------------
# Lifespan
# ---------------------------------------------------------------------------

@asynccontextmanager
async def subscriptions_lifespan():
    router: NineRouter = NineRouter.get()
    try:
        await router.ensure_running()
    except Exception as e:
        debug(f"9Router auto-start failed: {e}")
    yield
    try:
        await router.stop()
    except Exception:
        pass


subscriptions = SubApp("subscriptions", subscriptions_lifespan)


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@subscriptions.router.get("/status")
async def subscriptions_status() -> dict:
    router: NineRouter = NineRouter.get()
    if not router.is_running():
        await router.ensure_running_background()
        return {"running": False, "providers": [], "models": []}
    providers = await router.get_providers()
    models = await router.get_models()
    return {"running": True, "providers": providers, "models": models}


@subscriptions.router.post("/connect")
async def subscriptions_connect(body: dict) -> dict:
    provider: str = body.get("provider", "")
    if not provider:
        raise HTTPException(status_code=400, detail="provider required")

    router: NineRouter = NineRouter.get()
    if not router.is_running():
        await router.ensure_running()
        if not router.is_running():
            raise HTTPException(status_code=503, detail="9Router not available. Please install Node.js.")

    try:
        result: dict = await router.start_oauth(provider)
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
        result: dict = await NineRouter.get().poll_oauth(
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

    router: NineRouter = NineRouter.get()
    try:
        providers_data = await router.get_providers()
        connections: list = providers_data.get("connections", []) if isinstance(providers_data, dict) else []
        conn = next((c for c in connections if c.get("provider") == provider), None)
        if conn and conn.get("id"):
            await router.disconnect_provider(conn["id"])
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
        await NineRouter.get().exchange_oauth(
            pending["provider"], code,
            pending["redirect_uri"], pending["code_verifier"], state,
        )
    except Exception as e:
        debug(f"OAuth callback: exchange failed for provider={pending['provider']}: {e}")
        return HTMLResponse(
            f'<html><body {ERROR_STYLE}><div style="text-align:center">'
            f'<h2>Connection failed</h2><p style="color:#888">{e}</p></div></body></html>'
        )

    return HTMLResponse(SUCCESS_HTML)
