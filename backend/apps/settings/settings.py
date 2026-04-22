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
from typing import Optional

from backend.config.Apps import SubApp
from backend.apps.settings.models import AppSettings, DEFAULT_SYSTEM_PROMPT

logger = logging.getLogger(__name__)

from backend.config.paths import SETTINGS_DIR as DATA_DIR

SETTINGS_FILE = os.path.join(DATA_DIR, "settings.json")


@asynccontextmanager
async def settings_lifespan():
    os.makedirs(DATA_DIR, exist_ok=True)
    yield


settings = SubApp("settings", settings_lifespan)


def _migrate_legacy_fields(raw: dict) -> dict:
    """Translate deprecated field names/values so they survive into the new schema.

    Pre-launch scaffolding used `connection_mode="managed"` and
    `openswarm_auth_token`; production names are `"openswarm-pro"` and
    `openswarm_bearer_token`. Zero known users are affected, but keep the
    mapping for safety.
    """
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


# Single threading.Lock guards every write to SETTINGS_FILE — protects against
# corruption from two requests racing through the file system. Async callers
# offload the actual write to the default thread pool (run_in_executor), so
# the lock works for both sync and thread-pool execution paths.
_settings_write_lock = threading.Lock()


def _atomic_write_settings(payload: dict) -> None:
    """Internal: serialise payload to SETTINGS_FILE atomically.
    Always called via save_settings* — don't invoke directly."""
    with _settings_write_lock:
        os.makedirs(DATA_DIR, exist_ok=True)
        fd, tmp = tempfile.mkstemp(prefix=".settings.", suffix=".tmp", dir=DATA_DIR)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(payload, f, indent=2)
            # On Windows, os.replace can transiently fail with PermissionError
            # if Defender or another reader holds the destination open. One
            # retry after a short backoff handles every real-world case
            # without masking genuine permission bugs.
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
    """Synchronously persist settings atomically. Thread-safe.
    Use from sync paths (analytics collector, lifespans). Async callers should
    prefer save_settings_async to avoid blocking the event loop on Windows
    where Defender scans can stretch the write to 50-200ms."""
    _atomic_write_settings(settings_obj.model_dump())


async def save_settings_async(settings_obj: AppSettings) -> None:
    """Async-safe atomic save. Runs the file I/O in the default thread pool
    so the FastAPI event loop stays responsive while the write completes.
    Shares the threading.Lock with the sync variant for safe interleaving."""
    payload = settings_obj.model_dump()
    loop = asyncio.get_running_loop()
    await loop.run_in_executor(None, _atomic_write_settings, payload)


# Backward-compat alias. Existing sync callers (analytics collector, analytics
# lifespan) continue to work; new async callers should use save_settings_async.
def _save_settings(settings_obj: AppSettings) -> None:
    save_settings(settings_obj)


@settings.router.get("")
async def get_settings():
    return load_settings().model_dump()


@settings.router.put("")
async def update_settings(body: AppSettings):
    from backend.apps.analytics.collector import record as _analytics

    old = load_settings()

    # Track provider key changes
    provider_keys = {
        "anthropic_api_key": "anthropic",
        "openai_api_key": "openai",
        "google_api_key": "gemini",
        "openrouter_api_key": "openrouter",
    }
    for key, provider_name in provider_keys.items():
        old_val = bool(getattr(old, key, None))
        new_val = bool(getattr(body, key, None))
        if old_val != new_val:
            _analytics("provider.configured", {
                "provider": provider_name,
                "action": "added" if new_val else "removed",
            })

    # Track settings changes (key names only, not values)
    old_dict = old.model_dump()
    new_dict = body.model_dump()
    secret_keys = {"anthropic_api_key", "openai_api_key", "google_api_key", "openrouter_api_key",
                   "claude_subscription_token", "openai_subscription_token", "gemini_subscription_token",
                   "copilot_github_token", "copilot_token", "installation_id"}
    safe_changed = [
        k for k in new_dict
        if k in old_dict and new_dict[k] != old_dict[k] and k not in secret_keys
    ]
    if safe_changed:
        _analytics("settings.changed", {"changed_keys": safe_changed})

    # Identify user in PostHog when profile is set/changed
    if (body.user_email and body.user_email != getattr(old, "user_email", None)) or \
       (body.user_name and body.user_name != getattr(old, "user_name", None)):
        from backend.apps.analytics.collector import identify as _identify
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
    return {"ok": True, "settings": body.model_dump()}


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
