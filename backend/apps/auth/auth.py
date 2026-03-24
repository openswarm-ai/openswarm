"""Auth SubApp — handles managed-mode authentication with Open Swarm service.

All endpoints are currently stubbed with mock responses so the full UI flow
works end-to-end without a real proxy server.
"""

from contextlib import asynccontextmanager
from uuid import uuid4

from pydantic import BaseModel
from typing import Optional

from backend.config.Apps import SubApp
from backend.apps.settings.settings import load_settings, update_settings


# ── Models ──────────────────────────────────────────────────────────────

class LoginRequest(BaseModel):
    email: str
    password: str


class GoogleCallbackRequest(BaseModel):
    code: str
    redirect_uri: str = ""


class LoginResponse(BaseModel):
    ok: bool
    token: Optional[str] = None
    email: Optional[str] = None
    proxy_url: Optional[str] = None
    error: Optional[str] = None


class ValidateResponse(BaseModel):
    valid: bool
    email: Optional[str] = None


class UsageResponse(BaseModel):
    used_usd: float
    quota_usd: float
    reset_date: str


# ── SubApp setup ────────────────────────────────────────────────────────

@asynccontextmanager
async def _lifespan():
    yield

auth = SubApp("auth", _lifespan)
router = auth.router


# ── Endpoints ───────────────────────────────────────────────────────────

@router.post("/login")
async def login(req: LoginRequest) -> LoginResponse:
    """Authenticate with email + password.

    TODO: replace with real API call to Open Swarm auth server.
    """
    if not req.email or not req.password:
        return LoginResponse(ok=False, error="Email and password are required")

    # Stub: generate a mock token for any valid-looking input
    mock_token = f"osw_{uuid4().hex}"
    proxy_url = "https://api.openswarm.ai"

    # Persist credentials to settings
    settings = load_settings()
    settings.connection_mode = "managed"
    settings.openswarm_auth_token = mock_token
    settings.openswarm_proxy_url = proxy_url
    settings.openswarm_user_email = req.email
    await _save_settings(settings)

    return LoginResponse(ok=True, token=mock_token, email=req.email, proxy_url=proxy_url)


@router.post("/google-url")
async def google_auth_url() -> dict:
    """Return the Google OAuth authorize URL.

    TODO: replace with real Google OAuth URL construction.
    """
    # Stub: return a placeholder URL
    return {
        "url": "https://accounts.google.com/o/oauth2/v2/auth?client_id=PLACEHOLDER&response_type=code&scope=email+profile&redirect_uri=http://localhost:8324/api/auth/google-callback"
    }


@router.post("/google-callback")
async def google_callback(req: GoogleCallbackRequest) -> LoginResponse:
    """Exchange Google OAuth code for a session token.

    TODO: replace with real OAuth code exchange + Open Swarm auth server call.
    """
    if not req.code:
        return LoginResponse(ok=False, error="Authorization code is required")

    # Stub: generate a mock token
    mock_token = f"osw_{uuid4().hex}"
    proxy_url = "https://api.openswarm.ai"
    mock_email = "user@gmail.com"

    settings = load_settings()
    settings.connection_mode = "managed"
    settings.openswarm_auth_token = mock_token
    settings.openswarm_proxy_url = proxy_url
    settings.openswarm_user_email = mock_email
    await _save_settings(settings)

    return LoginResponse(ok=True, token=mock_token, email=mock_email, proxy_url=proxy_url)


@router.post("/validate")
async def validate_token() -> ValidateResponse:
    """Check if the stored auth token is still valid.

    TODO: replace with real validation call to Open Swarm auth server.
    """
    settings = load_settings()
    if not settings.openswarm_auth_token:
        return ValidateResponse(valid=False)

    # Stub: always return valid
    return ValidateResponse(valid=True, email=settings.openswarm_user_email)


@router.post("/logout")
async def logout() -> dict:
    """Clear managed-mode credentials from settings."""
    settings = load_settings()
    settings.connection_mode = "own_key"
    settings.openswarm_auth_token = None
    settings.openswarm_proxy_url = None
    settings.openswarm_user_email = None
    await _save_settings(settings)
    return {"ok": True}


@router.get("/usage")
async def get_usage() -> UsageResponse:
    """Fetch usage and quota information for the current managed-mode user.

    TODO: replace with real API call to Open Swarm proxy server.
    """
    settings = load_settings()
    if not settings.openswarm_auth_token:
        return UsageResponse(used_usd=0, quota_usd=0, reset_date="")

    # Stub: return mock usage data
    return UsageResponse(used_usd=0, quota_usd=50, reset_date="2026-04-01")


# ── Helpers ─────────────────────────────────────────────────────────────

async def _save_settings(settings):
    """Persist settings to disk (reuses the settings module's update logic)."""
    import json
    from backend.apps.settings.settings import SETTINGS_FILE

    with open(SETTINGS_FILE, "w") as f:
        json.dump(settings.model_dump(), f, indent=2)
