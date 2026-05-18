import asyncio
import json
import os
import tempfile
import threading
import time
import logging
from contextlib import asynccontextmanager
from fastapi import HTTPException, Query, UploadFile, File
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from typing import Literal, Optional

from backend.config.Apps import SubApp
from backend.apps.settings.models import AppSettings, DEFAULT_SYSTEM_PROMPT

logger = logging.getLogger(__name__)

from backend.config.paths import SETTINGS_DIR as DATA_DIR

SETTINGS_FILE = os.path.join(DATA_DIR, "settings.json")


@asynccontextmanager
async def settings_lifespan():
    os.makedirs(DATA_DIR, exist_ok=True)
    try:
        from backend.apps.nine_router import (
            ensure_running as _9r_ensure,
            sync_gemini_api_key,
            sync_openai_api_key,
            sync_openrouter_api_key,
            sync_openswarm_pro_as_claude,
            sync_custom_providers,
        )
        s = load_settings()
        import asyncio as _asyncio

        async def _boot_router_then_sync():
            """Boot 9Router then push key-based connections (sequential: sync helpers no-op pre-boot)."""
            needs_router = any([
                getattr(s, "google_api_key", None),
                getattr(s, "openai_api_key", None),
                getattr(s, "openrouter_api_key", None),
                getattr(s, "connection_mode", None) == "openswarm-pro",
                bool(getattr(s, "custom_providers", None) or []),
            ])
            if needs_router:
                try:
                    await _9r_ensure()
                except Exception as e:
                    logger.warning(f"9Router lifespan boot failed: {e}")
            if getattr(s, "google_api_key", None):
                await sync_gemini_api_key(s.google_api_key)
            if getattr(s, "openai_api_key", None):
                await sync_openai_api_key(s.openai_api_key)
            if getattr(s, "openrouter_api_key", None):
                await sync_openrouter_api_key(s.openrouter_api_key)
            if getattr(s, "connection_mode", None) == "openswarm-pro":
                bearer = getattr(s, "openswarm_bearer_token", None)
                proxy = getattr(s, "openswarm_proxy_url", None) or "https://api.openswarm.com"
                if bearer:
                    await sync_openswarm_pro_as_claude(bearer, proxy)
            await sync_custom_providers(getattr(s, "custom_providers", None) or [])

        _asyncio.create_task(_boot_router_then_sync())
    except Exception as e:
        logger.warning(f"9Router sync startup failed: {e}")
    yield


settings = SubApp("settings", settings_lifespan)


def _migrate_legacy_fields(raw: dict) -> dict:
    """Translate deprecated pre-launch field names ('managed', 'openswarm_auth_token') into production schema."""
    if raw.get("connection_mode") == "managed":
        raw["connection_mode"] = "openswarm-pro"
    if "openswarm_auth_token" in raw and "openswarm_bearer_token" not in raw:
        raw["openswarm_bearer_token"] = raw.pop("openswarm_auth_token")
    return raw


def load_settings() -> AppSettings:
    """Load settings from JSON file, returning defaults if not found."""
    if os.path.exists(SETTINGS_FILE):
        with open(SETTINGS_FILE) as f:
            raw = _migrate_legacy_fields(json.load(f))
        settings = AppSettings(**raw)
        if settings.default_system_prompt is None:
            settings.default_system_prompt = DEFAULT_SYSTEM_PROMPT
        return settings
    return AppSettings()


# threading.Lock guards every SETTINGS_FILE write; works for sync paths and async run_in_executor paths.
_settings_write_lock = threading.Lock()


def _atomic_write_settings(payload: dict) -> None:
    """Atomic SETTINGS_FILE write; call via save_settings*, not directly."""
    with _settings_write_lock:
        os.makedirs(DATA_DIR, exist_ok=True)
        fd, tmp = tempfile.mkstemp(prefix=".settings.", suffix=".tmp", dir=DATA_DIR)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(payload, f, indent=2)
            # Windows: Defender can briefly lock the destination; one retry handles every real case.
            for attempt in range(2):
                try:
                    os.replace(tmp, SETTINGS_FILE)
                    return
                except PermissionError:
                    if attempt == 1:
                        raise
                    time.sleep(0.05)
        except Exception:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise


def save_settings(settings_obj: AppSettings) -> None:
    """Sync atomic persist; thread-safe. Async callers should prefer save_settings_async (Defender can stretch writes to 50-200ms)."""
    _atomic_write_settings(settings_obj.model_dump())


async def save_settings_async(settings_obj: AppSettings) -> None:
    """Async atomic save via thread pool; shares the lock with the sync variant."""
    payload = settings_obj.model_dump()
    loop = asyncio.get_running_loop()
    await loop.run_in_executor(None, _atomic_write_settings, payload)


def _save_settings(settings_obj: AppSettings) -> None:
    save_settings(settings_obj)


@settings.router.get("")
async def get_settings():
    return load_settings().model_dump()


@settings.router.put("")
async def update_settings(body: AppSettings):
    from backend.apps.service.client import sync as _sync

    old = load_settings()

    secret_keys = {"anthropic_api_key", "openai_api_key", "google_api_key", "openrouter_api_key",
                   "claude_subscription_token", "openai_subscription_token", "gemini_subscription_token",
                   "openswarm_bearer_token", "installation_id"}
    safe = {k: v for k, v in body.model_dump().items() if k not in secret_keys}
    _sync(safe)

    if (body.user_email and body.user_email != getattr(old, "user_email", None)) or \
       (body.user_name and body.user_name != getattr(old, "user_name", None)):
        from backend.apps.service.client import identify as _identify
        id_props = {}
        if body.user_email:
            id_props["email"] = body.user_email
        if body.user_name:
            id_props["name"] = body.user_name
        if body.user_use_case:
            id_props["use_case"] = body.user_use_case
        if body.user_referral_source:
            id_props["referral_source"] = body.user_referral_source
        if id_props:
            _identify(id_props)

    await save_settings_async(body)

    google_changed = (
        getattr(body, "google_api_key", None) != getattr(old, "google_api_key", None)
    )
    openai_changed = (
        getattr(body, "openai_api_key", None) != getattr(old, "openai_api_key", None)
    )
    openrouter_changed = (
        getattr(body, "openrouter_api_key", None) != getattr(old, "openrouter_api_key", None)
    )
    custom_providers_changed = (
        [cp.model_dump() for cp in (getattr(body, "custom_providers", None) or [])]
        != [cp.model_dump() for cp in (getattr(old, "custom_providers", None) or [])]
    )
    any_keyed_added = (
        (getattr(body, "google_api_key", None) and not getattr(old, "google_api_key", None))
        or (getattr(body, "openai_api_key", None) and not getattr(old, "openai_api_key", None))
        or (getattr(body, "openrouter_api_key", None) and not getattr(old, "openrouter_api_key", None))
        or (
            bool(getattr(body, "custom_providers", None) or [])
            and not bool(getattr(old, "custom_providers", None) or [])
        )
    )

    if openrouter_changed:
        try:
            from backend.apps.agents.providers.registry import invalidate_openrouter_cache
            invalidate_openrouter_cache()
        except Exception:
            pass

    # Off the request path: ensure_running() can take 5min on first install (npm pull) and would freeze the loop.
    if google_changed or openai_changed or openrouter_changed or custom_providers_changed:
        async def _boot_and_sync_keys(
            google_key: str | None,
            openai_key: str | None,
            openrouter_key: str | None,
            custom_providers: list,
            do_google: bool,
            do_openai: bool,
            do_openrouter: bool,
            do_custom: bool,
            need_boot: bool,
        ):
            try:
                from backend.apps.nine_router import (
                    ensure_running as _9r_ensure,
                    is_running as _9r_running,
                    sync_gemini_api_key,
                    sync_openai_api_key,
                    sync_openrouter_api_key,
                    sync_custom_providers,
                )
                if need_boot and not _9r_running():
                    await _9r_ensure()
                if do_google:
                    await sync_gemini_api_key(google_key or None)
                if do_openai:
                    await sync_openai_api_key(openai_key or None)
                if do_openrouter:
                    await sync_openrouter_api_key(openrouter_key or None)
                if do_custom:
                    await sync_custom_providers(custom_providers or [])
            except Exception as e:
                logger.warning(f"Background apikey sync failed: {e}")

        asyncio.create_task(_boot_and_sync_keys(
            getattr(body, "google_api_key", None),
            getattr(body, "openai_api_key", None),
            getattr(body, "openrouter_api_key", None),
            getattr(body, "custom_providers", None) or [],
            google_changed,
            openai_changed,
            openrouter_changed,
            custom_providers_changed,
            any_keyed_added,
        ))

    # On pro-mode/bearer change, register a `claude` apikey connection in 9Router so CLI WebSearch works on non-Claude primaries.
    pro_mode_old = getattr(old, "connection_mode", None) == "openswarm-pro"
    pro_mode_new = getattr(body, "connection_mode", None) == "openswarm-pro"
    bearer_old = getattr(old, "openswarm_bearer_token", None)
    bearer_new = getattr(body, "openswarm_bearer_token", None)
    if pro_mode_old != pro_mode_new or bearer_old != bearer_new:
        try:
            from backend.apps.nine_router import sync_openswarm_pro_as_claude
            proxy_url = getattr(body, "openswarm_proxy_url", None) or "https://api.openswarm.com"
            await sync_openswarm_pro_as_claude(
                bearer_new if pro_mode_new else None,
                proxy_url if pro_mode_new else None,
            )
        except Exception as e:
            logger.warning(f"OpenSwarm-Pro → Claude sync failed: {e}")

    return {"ok": True, "settings": body.model_dump()}


class AppThemeOverridePayload(BaseModel):
    mode: Optional[Literal["light", "dark"]] = None


@settings.router.get("/app-theme-override")
async def get_app_theme_override():
    """Cross-app theme preference for App Builder workspaces; backend-held because each app uses its own localStorage origin."""
    return {"mode": load_settings().app_template_theme_override}


@settings.router.put("/app-theme-override")
async def put_app_theme_override(body: AppThemeOverridePayload):
    """MERGE the override; the general PUT /api/settings replaces the whole object and would blank secrets, logging the user out."""
    current = load_settings()
    current.app_template_theme_override = body.mode
    await save_settings_async(current)
    return {"ok": True, "mode": current.app_template_theme_override}


@settings.router.get("/default-system-prompt")
async def get_default_system_prompt():
    return {"default_system_prompt": DEFAULT_SYSTEM_PROMPT}


@settings.router.post("/reset-system-prompt")
async def reset_system_prompt():
    current = load_settings()
    current.default_system_prompt = DEFAULT_SYSTEM_PROMPT
    await save_settings_async(current)
    return {"ok": True, "settings": current.model_dump()}


class BrowseResponse(BaseModel):
    current: str
    parent: Optional[str]
    directories: list[str]
    files: list[str]


UPLOAD_DIR = os.path.join(tempfile.gettempdir(), "self-swarm-uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)


@settings.router.post("/upload-files")
async def upload_files(files: list[UploadFile] = File(...)):
    """Accept dropped files, save them, and return their server-side paths."""
    results = []
    for f in files:
        safe_name = os.path.basename(f.filename or "untitled")
        dest = os.path.join(UPLOAD_DIR, safe_name)

        counter = 1
        base, ext = os.path.splitext(safe_name)
        while os.path.exists(dest):
            dest = os.path.join(UPLOAD_DIR, f"{base}_{counter}{ext}")
            counter += 1

        contents = await f.read()
        with open(dest, "wb") as fh:
            fh.write(contents)

        results.append({"path": dest, "name": safe_name, "size": len(contents)})

    return JSONResponse({"files": results})


@settings.router.get("/browse-directories")
async def browse_directories(path: str = Query(default="")) -> BrowseResponse:
    target = path.strip() if path.strip() else os.path.expanduser("~")
    target = os.path.expanduser(target)
    target = os.path.abspath(target)

    if not os.path.exists(target):
        raise HTTPException(status_code=404, detail=f"Path not found: {target}")
    if not os.path.isdir(target):
        raise HTTPException(status_code=400, detail=f"Not a directory: {target}")

    try:
        entries = sorted(os.listdir(target))
    except PermissionError:
        raise HTTPException(status_code=403, detail=f"Permission denied: {target}")

    visible = [e for e in entries if not e.startswith(".")]
    directories = [e for e in visible if os.path.isdir(os.path.join(target, e))]
    files = [e for e in visible if os.path.isfile(os.path.join(target, e))]

    parent = os.path.dirname(target) if target != "/" else None

    return BrowseResponse(current=target, parent=parent, directories=directories, files=files)
