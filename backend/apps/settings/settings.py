import json
import os
import tempfile
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


def load_settings() -> AppSettings:
    """Load settings from JSON file, returning defaults if not found."""
    if os.path.exists(SETTINGS_FILE):
        with open(SETTINGS_FILE) as f:
            settings = AppSettings(**json.load(f))
        if settings.default_system_prompt is None:
            settings.default_system_prompt = DEFAULT_SYSTEM_PROMPT
        return settings
    return AppSettings()


def _save_settings(settings_obj: AppSettings):
    """Persist settings to JSON file."""
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(SETTINGS_FILE, "w") as f:
        json.dump(settings_obj.model_dump(), f, indent=2)


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

    os.makedirs(DATA_DIR, exist_ok=True)
    with open(SETTINGS_FILE, "w") as f:
        json.dump(body.model_dump(), f, indent=2)
    return {"ok": True, "settings": body.model_dump()}


@settings.router.post("/reset-system-prompt")
async def reset_system_prompt():
    current = load_settings()
    current.default_system_prompt = DEFAULT_SYSTEM_PROMPT
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(SETTINGS_FILE, "w") as f:
        json.dump(current.model_dump(), f, indent=2)
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
