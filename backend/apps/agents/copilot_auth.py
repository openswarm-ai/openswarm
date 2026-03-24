"""GitHub Copilot device flow OAuth + token management.

Handles the full flow:
1. Start device flow → get user_code for user to enter at github.com/login/device
2. Poll until user authorizes → get GitHub access token
3. Exchange GitHub token → Copilot JWT (expires every ~30min)
4. Auto-refresh Copilot token before expiry
"""

import logging
import time

import httpx

logger = logging.getLogger(__name__)

CLIENT_ID = "Iv1.b507a08c87ecfe98"  # Copilot's public OAuth app ID
DEVICE_CODE_URL = "https://github.com/login/device/code"
TOKEN_URL = "https://github.com/login/oauth/access_token"
COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token"
COPILOT_API_BASE = "https://api.githubcopilot.com"

HEADERS = {
    "accept": "application/json",
    "content-type": "application/json",
    "editor-version": "vscode/1.100.0",
    "editor-plugin-version": "copilot-chat/0.30.0",
    "user-agent": "GithubCopilot/1.200.0",
}


async def start_device_flow() -> dict:
    """Start GitHub device flow.

    Returns: {user_code, verification_uri, device_code, expires_in, interval}
    """
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.post(
            DEVICE_CODE_URL,
            headers=HEADERS,
            json={"client_id": CLIENT_ID, "scope": "read:user"},
        )
        resp.raise_for_status()
        data = resp.json()
        return {
            "user_code": data["user_code"],
            "verification_uri": data["verification_uri"],
            "device_code": data["device_code"],
            "expires_in": data.get("expires_in", 900),
            "interval": data.get("interval", 5),
        }


async def poll_for_token(device_code: str) -> str | None:
    """Poll GitHub for token after user authorizes.

    Returns the GitHub access token (gho_xxx), or None if still pending.
    Raises on error (expired, denied, etc.)
    """
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.post(
            TOKEN_URL,
            headers=HEADERS,
            json={
                "client_id": CLIENT_ID,
                "device_code": device_code,
                "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
            },
        )
        data = resp.json()

        if "access_token" in data:
            return data["access_token"]

        error = data.get("error", "")
        if error == "authorization_pending":
            return None  # Still waiting
        if error == "slow_down":
            return None  # Need to slow down polling
        if error in ("expired_token", "access_denied"):
            raise ValueError(f"GitHub auth failed: {error}")

        return None


async def exchange_for_copilot_token(github_token: str) -> dict:
    """Exchange GitHub OAuth token for Copilot JWT.

    Returns: {token, expires_at}
    """
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.get(
            COPILOT_TOKEN_URL,
            headers={
                **HEADERS,
                "authorization": f"token {github_token}",
            },
        )
        if resp.status_code == 401:
            raise ValueError("GitHub token invalid or expired. Please re-authenticate.")
        if resp.status_code == 403:
            raise ValueError("No Copilot subscription found for this GitHub account.")
        resp.raise_for_status()

        data = resp.json()
        token = data.get("token", "")

        # Extract expiry from token (format: tid=xxx;exp=1234567890;...)
        expires_at = time.time() + 25 * 60  # Default 25 min
        if "exp=" in token:
            try:
                for pair in token.split(";"):
                    if pair.strip().startswith("exp="):
                        expires_at = int(pair.strip().split("=")[1])
                        break
            except (ValueError, IndexError):
                pass

        return {"token": token, "expires_at": expires_at}


async def get_copilot_token(github_token: str, current_token: str | None = None, expires_at: float | None = None) -> dict:
    """Get a valid Copilot token, refreshing if needed.

    Returns: {token, expires_at}
    """
    # If current token is still valid (with 2 min buffer), return it
    if current_token and expires_at and time.time() < expires_at - 120:
        return {"token": current_token, "expires_at": expires_at}

    # Otherwise refresh
    return await exchange_for_copilot_token(github_token)


async def list_copilot_models(copilot_token: str) -> list[dict]:
    """Fetch available models from Copilot API."""
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.get(
            f"{COPILOT_API_BASE}/models",
            headers={
                "authorization": f"Bearer {copilot_token}",
                "copilot-integration-id": "vscode-chat",
                **HEADERS,
            },
        )
        if resp.status_code != 200:
            logger.warning(f"Failed to list Copilot models: {resp.status_code}")
            return []

        data = resp.json()
        models = data.get("data", data.get("models", []))
        return [
            {
                "value": m.get("id", m.get("name", "")),
                "label": m.get("name", m.get("id", "")),
                "context_window": m.get("context_window", 128_000),
            }
            for m in models
            if isinstance(m, dict)
        ]


async def get_github_username(github_token: str) -> str | None:
    """Get the GitHub username for display."""
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(
                "https://api.github.com/user",
                headers={"authorization": f"token {github_token}", "accept": "application/json"},
            )
            if resp.status_code == 200:
                return resp.json().get("login")
    except Exception:
        pass
    return None
