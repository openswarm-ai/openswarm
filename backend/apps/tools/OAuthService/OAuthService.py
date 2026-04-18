"""OAuth service — token exchange, refresh, disconnect, flow initiation.

Pure business logic with no HTTP/FastAPI dependencies.
"""

import base64
import hashlib
import os
import secrets
import time
from typing import Any, Optional, Tuple
from urllib.parse import urlencode

import httpx
from pydantic import BaseModel, Field
from typing import Dict
from backend.apps.tools.OAuthService.OAUTH_PROVIDERS.OAuthProvider import OAuthProvider
from backend.apps.tools.OAuthService.OAUTH_PROVIDERS.OAUTH_PROVIDERS import OAUTH_PROVIDERS
from backend.apps.tools.shared_utils.ToolDefinition import ToolDefinition
from backend.core.db.PydanticStore import PydanticStore
from swarm_debug import debug
from typeguard import typechecked
from backend.ports import BACKEND_DEV_PORT


class OAuthService(BaseModel):
    store: PydanticStore[ToolDefinition]
    pending_oauth: Dict[str, str] = Field(default_factory=dict)
    pending_pkce: Dict[str, str] = Field(default_factory=dict)

    @typechecked
    def p_redirect_uri(self) -> str:
        port = os.environ.get("OPENSWARM_PORT", str(BACKEND_DEV_PORT))
        return f"http://localhost:{port}/api/tools/oauth/callback"

    @typechecked
    async def start_flow(self, tool_id: str) -> str:
        """Build the authorization URL and stash pending state.

        Returns the full auth URL the client should redirect to.
        Raises ValueError if the provider's client ID env var is unset.
        """
        tool: ToolDefinition = self.store.load(tool_id)
        provider: OAuthProvider = OAUTH_PROVIDERS[tool.oauth_provider]

        client_id: str = os.environ.get(provider.client_id_env, "")
        if not client_id:
            raise ValueError(f"{provider.client_id_env} not set in backend .env")

        assert tool.oauth_provider is not None

        provider_key: str = tool.oauth_provider
        state: str = f"{provider_key}:{tool_id}"
        self.pending_oauth[state] = tool_id

        params: Dict[str, str] = {
            "client_id": client_id,
            "redirect_uri": self._redirect_uri(),
            "response_type": "code",
            "state": state,
            **provider.extra_auth_params,
        }
        if provider.scopes:
            params["scope"] = " ".join(provider.scopes)

        if provider.pkce_required:
            code_verifier: str = secrets.token_urlsafe(64)
            code_challenge: str = (
                base64.urlsafe_b64encode(hashlib.sha256(code_verifier.encode()).digest())
                .rstrip(b"=")
                .decode()
            )
            params["code_challenge"] = code_challenge
            params["code_challenge_method"] = "S256"
            self.pending_pkce[state] = code_verifier

        return f"{provider.auth_url}?{urlencode(params)}"

    @typechecked
    async def handle_callback(self, code: str, state: str) -> Tuple[str, ToolDefinition]:
        """Exchange the authorization code for tokens and persist them.

        Returns (tool_id, updated_tool) on success.
        Raises LookupError if the state token is unknown.
        """
        tool_id: Optional[str] = self.pending_oauth.pop(state, None)
        if not tool_id:
            alt_key: str = state.split(":")[-1] if ":" in state else state
            tool_id = self.pending_oauth.pop(alt_key, None)
        if not tool_id:
            raise LookupError("Invalid OAuth state")

        tool: ToolDefinition = self.store.load(tool_id)
        provider: OAuthProvider = OAUTH_PROVIDERS[tool.oauth_provider]

        client_id: str = os.environ.get(provider.client_id_env, "")
        client_secret: str = os.environ.get(provider.client_secret_env, "")

        token_data: Dict[str, str] = {
            "code": code,
            "redirect_uri": self._redirect_uri(),
            "grant_type": "authorization_code",
        }
        headers: Dict[str, str] = {}

        if provider.token_auth_method == "basic":
            creds: str = base64.b64encode(f"{client_id}:{client_secret}".encode()).decode()
            headers["Authorization"] = f"Basic {creds}"
        elif provider.token_auth_method == "basic_json":
            creds: str = base64.b64encode(f"{client_id}:{client_secret}".encode()).decode()
            headers["Authorization"] = f"Basic {creds}"
            headers["Content-Type"] = "application/json"
        else:
            token_data["client_id"] = client_id
            token_data["client_secret"] = client_secret

        if tool.oauth_provider == "github":
            headers["Accept"] = "application/json"

        code_verifier: Optional[str] = self.pending_pkce.pop(state, None)
        if code_verifier:
            token_data["code_verifier"] = code_verifier

        async with httpx.AsyncClient(timeout=15.0) as client:
            if provider.token_auth_method == "basic_json":
                resp = await client.post(provider.token_url, json=token_data, headers=headers)
            else:
                resp = await client.post(provider.token_url, data=token_data, headers=headers)

        if resp.status_code != 200:
            debug(f"OAuth token exchange failed: {resp.text}")
            raise RuntimeError(resp.text)

        tokens: Dict[str, Any] = resp.json()

        access_token: str = tokens.get("access_token", "")
        if provider.token_response_path and not access_token:
            obj: Dict[str, Any] = tokens
            for part in provider.token_response_path.split("."):
                obj = obj.get(part, {}) if isinstance(obj, dict) else ""
            if isinstance(obj, str) and obj:
                access_token = obj

        tool.oauth_tokens: Dict[str, Any] = {
            "access_token": access_token,
            "refresh_token": tokens.get("refresh_token", ""),
            "token_expiry": time.time() + tokens.get("expires_in", 3600),
        }

        for response_path, env_var in provider.extra_token_fields.items():
            obj_val: Dict[str, Any] = tokens
            for part in response_path.split("."):
                obj_val = obj_val.get(part, "") if isinstance(obj_val, dict) else ""
            if obj_val:
                tool.oauth_tokens[env_var] = str(obj_val)

        tool.auth_status = "connected"

        if access_token and provider.userinfo_url:
            tool.connected_account_email = await self.p_fetch_userinfo(
                provider.userinfo_url, provider.userinfo_field, access_token,
                label=tool.oauth_provider or "google",
            )

        if (tool.oauth_provider or "google") == "notion" and not tool.connected_account_email:
            workspace_name = tokens.get("workspace_name")
            if workspace_name:
                tool.connected_account_email = workspace_name

        self.store.save(tool)
        return tool_id, tool

    @typechecked
    async def disconnect(self, tool_id: str) -> ToolDefinition:
        """Revoke the access token (best-effort) and clear stored credentials."""
        tool: ToolDefinition = self.store.load(tool_id)
        access_token = tool.oauth_tokens.get("access_token")

        if access_token:
            provider: OAuthProvider = OAUTH_PROVIDERS[tool.oauth_provider]
            revoke_url: Optional[str] = provider.revoke_url
            assert revoke_url is not None, "Revoke URL is required"
            try:
                async with httpx.AsyncClient(timeout=10.0) as client:
                    await client.post(
                        revoke_url,
                        params={"token": access_token},
                        headers={"Content-Type": "application/x-www-form-urlencoded"},
                    )
            except Exception as e:
                debug(f"Failed to revoke token for tool {tool.id}: {e}")

        tool.oauth_tokens = {}
        tool.auth_status = "configured"
        tool.connected_account_email = None
        self.store.save(tool)
        return tool

    @typechecked
    async def refresh_token(self, tool: ToolDefinition) -> Optional[str]:
        """Refresh an expired OAuth token. Returns the fresh access_token or None.

        Mutates the tool in-place and saves to the store on success.
        """
        if tool.auth_type != "oauth2":
            return None
        refresh_tok = tool.oauth_tokens.get("refresh_token")
        if not refresh_tok:
            return None
        expiry = tool.oauth_tokens.get("token_expiry", 0)
        if time.time() < expiry - 60:
            return tool.oauth_tokens.get("access_token")

        provider: OAuthProvider = OAUTH_PROVIDERS[tool.oauth_provider]
        client_id: str = os.environ.get(provider.client_id_env, "")
        client_secret: str = os.environ.get(provider.client_secret_env, "")
        if not client_id or not client_secret:
            return None

        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                resp = await client.post(provider.token_url, data={
                    "client_id": client_id,
                    "client_secret": client_secret,
                    "refresh_token": refresh_tok,
                    "grant_type": "refresh_token",
                })
            if resp.status_code == 200:
                data = resp.json()
                new_token = data["access_token"]
                tool.oauth_tokens["access_token"] = new_token
                tool.oauth_tokens["token_expiry"] = time.time() + data.get("expires_in", 3600)

                if not tool.connected_account_email and provider.userinfo_url:
                    tool.connected_account_email = await self.p_fetch_userinfo(
                        provider.userinfo_url, provider.userinfo_field, new_token,
                    )

                self.store.save(tool)
                return new_token
        except Exception as e:
            debug(f"OAuth token refresh failed for tool {tool.id}: {e}")
        return None

    @typechecked
    async def p_fetch_userinfo(
        self, url: str, field: str, access_token: str, *, label: str = "",
    ) -> Optional[str]:
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp: httpx.Response = await client.get(url, headers={"Authorization": f"Bearer {access_token}"})
            if resp.status_code == 200:
                return resp.json().get(field)
        except Exception as e:
            debug(f"Failed to fetch userinfo{f' for {label}' if label else ''}: {e}")
        return None