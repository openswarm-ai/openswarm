"""HTTP client for 9Router's REST API."""

import httpx
from pydantic import Field, BaseModel, InstanceOf
from typeguard import typechecked

from backend.apps.subscriptions.NineRouter.helpers.constants import NINE_ROUTER_API, NINE_ROUTER_V1
from backend.ports import NINE_ROUTER_PORT


class NineRouterClient(BaseModel):
    p_http: InstanceOf[httpx.AsyncClient] = Field(default_factory=lambda: httpx.AsyncClient(timeout=15.0))

    async def aclose(self) -> None:
        await self.p_http.aclose()

    @typechecked
    async def get_providers(self) -> list[dict] | dict:
        try:
            r = await self.p_http.get(f"{NINE_ROUTER_API}/providers", timeout=5.0)
            if r.status_code == 200:
                return r.json()
        except Exception as e:
            print(f"9Router providers fetch failed: {e}")
        return []

    @typechecked
    async def start_oauth(self, provider: str) -> dict:
        """Start OAuth flow for a provider.

        device_code providers: returns {user_code, verification_uri, device_code}
        authorization_code providers: returns {authUrl, codeVerifier, state}
        """
        try:
            r = await self.p_http.get(f"{NINE_ROUTER_API}/oauth/{provider}/device-code")
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
        r = await self.p_http.get(
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
        self,
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

        r = await self.p_http.post(f"{NINE_ROUTER_API}/oauth/{provider}/poll", json=body)
        r.raise_for_status()
        return r.json()

    @typechecked
    async def exchange_oauth(
        self,
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
        r = await self.p_http.post(f"{NINE_ROUTER_API}/oauth/{provider}/exchange", json=payload)
        print(f"exchange_oauth: status={r.status_code}")
        r.raise_for_status()
        return r.json()

    @typechecked
    async def get_models(self) -> list[dict]:
        try:
            r = await self.p_http.get(f"{NINE_ROUTER_V1}/models", timeout=5.0)
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
    async def disconnect_provider(self, provider_id: str) -> bool:
        r = await self.p_http.delete(f"{NINE_ROUTER_API}/providers/{provider_id}", timeout=10.0)
        return r.status_code == 200
