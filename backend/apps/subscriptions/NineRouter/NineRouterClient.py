"""HTTP client for 9Router's REST API."""

import httpx
from typeguard import typechecked

from backend.apps.subscriptions.NineRouter.constants import NINE_ROUTER_API, NINE_ROUTER_V1
from backend.ports import NINE_ROUTER_PORT

@typechecked
async def get_providers() -> list[dict] | dict:
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.get(f"{NINE_ROUTER_API}/providers")
            if r.status_code == 200:
                return r.json()
    except Exception as e:
        print(f"9Router providers fetch failed: {e}")
    return []


@typechecked
async def start_oauth(provider: str) -> dict:
    """Start OAuth flow for a provider.

    device_code providers: returns {user_code, verification_uri, device_code}
    authorization_code providers: returns {authUrl, codeVerifier, state}
    """
    async with httpx.AsyncClient(timeout=15.0) as client:
        try:
            r = await client.get(f"{NINE_ROUTER_API}/oauth/{provider}/device-code")
            if r.status_code == 200:
                data: dict = r.json()
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

        callback_url: str = f"http://localhost:{NINE_ROUTER_PORT}/callback"
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
        }


@typechecked
async def poll_oauth(
    provider: str,
    device_code: str,
    code_verifier: str | None = None,
    extra_data: dict | None = None,
) -> dict:
    body: dict = {"deviceCode": device_code}
    if code_verifier:
        body["codeVerifier"] = code_verifier
    if extra_data:
        body["extraData"] = extra_data

    async with httpx.AsyncClient(timeout=15.0) as client:
        r = await client.post(f"{NINE_ROUTER_API}/oauth/{provider}/poll", json=body)
        r.raise_for_status()
        return r.json()


@typechecked
async def exchange_oauth(
    provider: str,
    code: str,
    redirect_uri: str,
    code_verifier: str,
    state: str = "",
) -> dict:
    payload: dict = {
        "code": code,
        "redirectUri": redirect_uri,
        "codeVerifier": code_verifier,
        "state": state,
    }
    print(f"exchange_oauth: provider={provider} redirect_uri={redirect_uri}")
    async with httpx.AsyncClient(timeout=15.0) as client:
        r = await client.post(f"{NINE_ROUTER_API}/oauth/{provider}/exchange", json=payload)
        print(f"exchange_oauth: status={r.status_code}")
        r.raise_for_status()
        return r.json()


@typechecked
async def get_models() -> list[dict]:
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.get(f"{NINE_ROUTER_V1}/models")
            if r.status_code == 200:
                data: dict = r.json()
                models: list = data.get("data", [])
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
        print(f"9Router models fetch failed: {e}")
    return []


@typechecked
async def disconnect_provider(provider_id: str) -> bool:
    async with httpx.AsyncClient(timeout=10.0) as client:
        r = await client.delete(f"{NINE_ROUTER_API}/providers/{provider_id}")
        return r.status_code == 200
