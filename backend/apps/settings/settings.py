import json
import os
from contextlib import asynccontextmanager

from backend.config.Apps import SubApp
from backend.apps.settings.AppSettings import AppSettings
from backend.apps.settings.DEFAULT_SYSTEM_PROMPT import DEFAULT_SYSTEM_PROMPT
from backend.config.paths import DB_ROOT

SETTINGS_DIR = os.path.join(DB_ROOT, "settings")
SETTINGS_FILE = os.path.join(SETTINGS_DIR, "settings.json")

@asynccontextmanager
async def settings_lifespan():
    os.makedirs(SETTINGS_DIR, exist_ok=True)
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


@settings.router.get("")
async def get_settings():
    return load_settings().model_dump()


@settings.router.put("")
async def update_settings(body: AppSettings):
    os.makedirs(SETTINGS_DIR, exist_ok=True)
    with open(SETTINGS_FILE, "w") as f:
        json.dump(body.model_dump(), f, indent=2)
    return {"ok": True, "settings": body.model_dump()}


@settings.router.post("/reset-system-prompt")
async def reset_system_prompt():
    current = load_settings()
    current.default_system_prompt = DEFAULT_SYSTEM_PROMPT
    os.makedirs(SETTINGS_DIR, exist_ok=True)
    with open(SETTINGS_FILE, "w") as f:
        json.dump(current.model_dump(), f, indent=2)
    return {"ok": True, "settings": current.model_dump()}


# TODO: I deleted the upload-files route bc we don't need to make temp files since we can
# just natively reference the files in a users computer via electron so temp dupes are redundant
# frontend and other rippling changes will need to be made to support this

# TODO: I deleted the browse-directories route bc this is only used for the Working directory 
# selection in settings. Hence, we should just use the native file system browser to select 
# the working directory. Rippling changes will need to be made to support this