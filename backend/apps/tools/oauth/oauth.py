"""OAuth flow logic — callback, start, disconnect, refresh.

The tool store is injected via set_store() from the tools sub-app
to avoid circular imports.
"""

import base64
import hashlib
import logging
import os
import secrets
import time
from typing import Any, Optional
from urllib.parse import urlencode

import httpx
from fastapi import HTTPException, Query
from fastapi.responses import HTMLResponse

from backend.apps.tools.oauth.oauth_providers import resolve_oauth_provider
from backend.core.db.PydanticStore import PydanticStore
from backend.apps.tools.shared_utils.ToolDefinition import ToolDefinition
from backend.ports import BACKEND_DEV_PORT

logger = logging.getLogger(__name__)

_pending_oauth: dict[str, str] = {}
_pending_pkce: dict[str, str] = {}

_store: Optional[PydanticStore[ToolDefinition]] = None


def set_store(store: PydanticStore[ToolDefinition]) -> None:
    global _store
    _store = store


def _get_store() -> PydanticStore[ToolDefinition]:
    assert _store is not None, "OAuth store not initialized — call set_store() first"
    return _store


async def oauth_callback(code: str = Query(...), state: str = Query("")) -> HTMLResponse:
    tool_id = _pending_oauth.pop(state, None)
    if not tool_id:
        tool_id = _pending_oauth.pop(state.split(":")[-1] if ":" in state else state, None)
    if not tool_id:
        return HTMLResponse("<html><body><h2>Invalid OAuth state</h2></body></html>", status_code=400)

    store = _get_store()
    tool = store.load(tool_id)
    provider = resolve_oauth_provider(tool.oauth_provider)

    client_id = os.environ.get(provider.client_id_env, "")
    client_secret = os.environ.get(provider.client_secret_env, "")
    port = os.environ.get("OPENSWARM_PORT", str(BACKEND_DEV_PORT))
    redirect_uri = f"http://localhost:{port}/api/tools/oauth/callback"

    token_data: dict[str, str] = {
        "code": code, "redirect_uri": redirect_uri, "grant_type": "authorization_code",
    }
    headers: dict[str, str] = {}

    if provider.token_auth_method == "basic":
        creds = base64.b64encode(f"{client_id}:{client_secret}".encode()).decode()
        headers["Authorization"] = f"Basic {creds}"
    elif provider.token_auth_method == "basic_json":
        creds = base64.b64encode(f"{client_id}:{client_secret}".encode()).decode()
        headers["Authorization"] = f"Basic {creds}"
        headers["Content-Type"] = "application/json"
    else:
        token_data["client_id"] = client_id
        token_data["client_secret"] = client_secret

    if (tool.oauth_provider or "google") == "github":
        headers["Accept"] = "application/json"

    code_verifier = _pending_pkce.pop(state, None)
    if code_verifier:
        token_data["code_verifier"] = code_verifier

    async with httpx.AsyncClient(timeout=15.0) as client:
        if provider.token_auth_method == "basic_json":
            resp = await client.post(provider.token_url, json=token_data, headers=headers)
        else:
            resp = await client.post(provider.token_url, data=token_data, headers=headers)

    if resp.status_code != 200:
        logger.warning(f"OAuth token exchange failed: {resp.text}")
        return HTMLResponse(
            f"<html><body><h2>Token exchange failed</h2><pre>{resp.text}</pre></body></html>",
            status_code=400,
        )

    tokens = resp.json()

    access_token = tokens.get("access_token", "")
    if provider.token_response_path and not access_token:
        obj: Any = tokens
        for part in provider.token_response_path.split("."):
            obj = obj.get(part, {}) if isinstance(obj, dict) else ""
        if isinstance(obj, str) and obj:
            access_token = obj

    tool.oauth_tokens = {
        "access_token": access_token,
        "refresh_token": tokens.get("refresh_token", ""),
        "token_expiry": time.time() + tokens.get("expires_in", 3600),
    }

    for response_path, env_var in provider.extra_token_fields.items():
        obj_val: Any = tokens
        for part in response_path.split("."):
            obj_val = obj_val.get(part, "") if isinstance(obj_val, dict) else ""
        if obj_val:
            tool.oauth_tokens[env_var] = str(obj_val)

    tool.auth_status = "connected"

    if access_token and provider.userinfo_url:
        try:
            async with httpx.AsyncClient(timeout=10.0) as info_client:
                info_resp = await info_client.get(
                    provider.userinfo_url,
                    headers={"Authorization": f"Bearer {access_token}"},
                )
            if info_resp.status_code == 200:
                tool.connected_account_email = info_resp.json().get(provider.userinfo_field)
        except Exception as e:
            logger.warning(f"Failed to fetch userinfo for {tool.oauth_provider or 'google'}: {e}")

    if (tool.oauth_provider or "google") == "notion" and not tool.connected_account_email:
        workspace_name = tokens.get("workspace_name")
        if workspace_name:
            tool.connected_account_email = workspace_name

    store.save(tool)

    return HTMLResponse(
        "<html><body>"
        '<h2 style="font-family:sans-serif;color:#22c55e">Connected successfully!</h2>'
        '<p style="font-family:sans-serif;color:#666">You can close this window.</p>'
        "<script>"
        "if (window.opener) window.opener.postMessage({type:'oauth_complete', tool_id:'" + tool_id + "'}, '*');"
        "setTimeout(() => window.close(), 1500);"
        "</script>"
        "</body></html>"
    )


async def oauth_start(tool_id: str) -> dict:
    store = _get_store()
    tool = store.load(tool_id)
    provider = resolve_oauth_provider(tool.oauth_provider)

    client_id = os.environ.get(provider.client_id_env, "")
    if not client_id:
        raise HTTPException(status_code=400, detail=f"{provider.client_id_env} not set in backend .env")

    port = os.environ.get("OPENSWARM_PORT", str(BACKEND_DEV_PORT))
    redirect_uri = f"http://localhost:{port}/api/tools/oauth/callback"
    provider_key = tool.oauth_provider or "google"
    state = f"{provider_key}:{tool_id}"

    _pending_oauth[state] = tool_id

    params: dict[str, str] = {
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "state": state,
        **provider.extra_auth_params,
    }
    if provider.scopes:
        params["scope"] = " ".join(provider.scopes)

    if provider.pkce_required:
        code_verifier = secrets.token_urlsafe(64)
        code_challenge = base64.urlsafe_b64encode(
            hashlib.sha256(code_verifier.encode()).digest()
        ).rstrip(b"=").decode()
        params["code_challenge"] = code_challenge
        params["code_challenge_method"] = "S256"
        _pending_pkce[state] = code_verifier

    auth_url = f"{provider.auth_url}?{urlencode(params)}"
    return {"auth_url": auth_url}


async def oauth_disconnect(tool_id: str) -> dict:
    store = _get_store()
    tool = store.load(tool_id)
    access_token = tool.oauth_tokens.get("access_token")

    if access_token:
        provider = resolve_oauth_provider(tool.oauth_provider)
        revoke_url = provider.revoke_url or "https://oauth2.googleapis.com/revoke"
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                await client.post(
                    revoke_url,
                    params={"token": access_token},
                    headers={"Content-Type": "application/x-www-form-urlencoded"},
                )
        except Exception as e:
            logger.warning(f"Failed to revoke token for tool {tool.id}: {e}")

    tool.oauth_tokens = {}
    tool.auth_status = "configured"
    tool.connected_account_email = None
    store.save(tool)
    return {"ok": True, "tool": tool.model_dump()}


async def refresh_oauth_token(tool: ToolDefinition) -> Optional[str]:
    """Refresh an expired OAuth token. Returns the fresh access_token or None.

    Mutates the tool in-place and saves to the store if refresh succeeds.
    """
    if tool.auth_type != "oauth2":
        return None
    refresh_token = tool.oauth_tokens.get("refresh_token")
    if not refresh_token:
        return None
    expiry = tool.oauth_tokens.get("token_expiry", 0)
    if time.time() < expiry - 60:
        return tool.oauth_tokens.get("access_token")

    provider = resolve_oauth_provider(tool.oauth_provider)
    client_id = os.environ.get(provider.client_id_env, "")
    client_secret = os.environ.get(provider.client_secret_env, "")
    if not client_id or not client_secret:
        return None

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(provider.token_url, data={
                "client_id": client_id,
                "client_secret": client_secret,
                "refresh_token": refresh_token,
                "grant_type": "refresh_token",
            })
        if resp.status_code == 200:
            data = resp.json()
            new_token = data["access_token"]
            tool.oauth_tokens["access_token"] = new_token
            tool.oauth_tokens["token_expiry"] = time.time() + data.get("expires_in", 3600)

            if not tool.connected_account_email and provider.userinfo_url:
                try:
                    async with httpx.AsyncClient(timeout=10.0) as info_client:
                        info_resp = await info_client.get(
                            provider.userinfo_url,
                            headers={"Authorization": f"Bearer {new_token}"},
                        )
                    if info_resp.status_code == 200:
                        tool.connected_account_email = info_resp.json().get(provider.userinfo_field)
                except Exception:
                    pass

            _get_store().save(tool)
            return new_token
    except Exception as e:
        logger.warning(f"OAuth token refresh failed for tool {tool.id}: {e}")
    return None
