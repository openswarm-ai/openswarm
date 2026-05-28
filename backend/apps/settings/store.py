"""Settings persistence primitives (read/write/migrate the settings.json file).

A leaf: imports only settings.models + config.paths, never service or
nine_router. Lets service.client reach load/save downward instead of looping
back up through settings.settings.
"""

import json
import os
import tempfile
import threading
import time

from backend.config.paths import SETTINGS_DIR as DATA_DIR
from backend.apps.settings.models import AppSettings, DEFAULT_SYSTEM_PROMPT

SETTINGS_FILE = os.path.join(DATA_DIR, "settings.json")


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


def _save_settings(settings_obj: AppSettings) -> None:
    save_settings(settings_obj)
