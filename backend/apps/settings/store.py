"""Settings persistence primitives (read/write/migrate the settings.json file).

A leaf: imports only settings.models + config.paths, never service or
nine_router. Lets service.client reach load/save downward instead of looping
back up through settings.settings.
"""

import json
import logging
import os
import tempfile
import threading
import time

from pydantic import ValidationError

from backend.config.paths import SETTINGS_DIR as DATA_DIR
from backend.apps.settings.models import AppSettings, DEFAULT_SYSTEM_PROMPT

logger = logging.getLogger(__name__)

SETTINGS_FILE = os.path.join(DATA_DIR, "settings.json")


def migrate_legacy_fields(raw: dict) -> dict:
    """Translate deprecated pre-launch field names ('managed', 'openswarm_auth_token') into production schema."""
    if raw.get("connection_mode") == "managed":
        raw["connection_mode"] = "openswarm-pro"
    if "openswarm_auth_token" in raw and "openswarm_bearer_token" not in raw:
        raw["openswarm_bearer_token"] = raw.pop("openswarm_auth_token")
    return raw


def p_coerce_settings(raw: dict) -> AppSettings:
    """Build AppSettings, surviving a settings.json written by a different app
    version. Unknown fields are already ignored by pydantic; the case this guards
    is a field whose TYPE drifted across versions (e.g. a list that is now a
    dict, or a Literal value that was retired). Without this, one stale field
    would raise ValidationError on every load and brick boot, the GET /api/settings
    endpoint, and agent dispatch. We drop only the offending top-level fields
    (those revert to defaults) and keep every still-valid one, mirroring the
    skip-but-preserve philosophy json_store already uses for schema mismatches."""
    try:
        return AppSettings(**raw)
    except ValidationError as e:
        bad = {err["loc"][0] for err in e.errors() if err.get("loc")}
        logger.warning("settings.json had invalid fields %s; reverting them to defaults", sorted(map(str, bad)))
        cleaned = {k: v for k, v in raw.items() if k not in bad}
        try:
            return AppSettings(**cleaned)
        except ValidationError:
            # Still invalid after dropping the flagged fields (nested shape we
            # can't surgically repair); fall back to all defaults rather than crash.
            logger.warning("settings.json still invalid after dropping bad fields; using defaults")
            return AppSettings()


def p_preserve_corrupt_settings() -> None:
    """Move an unparseable settings.json aside so boot proceeds on defaults while
    the original stays recoverable (the next save would otherwise overwrite it)."""
    try:
        backup = SETTINGS_FILE + ".corrupt"
        os.replace(SETTINGS_FILE, backup)
        logger.warning("settings.json was unparseable; preserved at %s", backup)
    except OSError:
        pass


# In-memory mirror of SETTINGS_FILE, revalidated by stat (mtime+size) on every load
# so even a hand-edited file or an unexpected writer is picked up immediately. A stat
# skips the open+parse+validate that Defender turns into 5-50ms on Windows. Copies on
# both sides keep handler isolation: callers mutate their copy, never the cache.
p_cached_settings: AppSettings | None = None
p_cached_sig: tuple[int, int] | None = None


def p_settings_sig() -> tuple[int, int] | None:
    try:
        st = os.stat(SETTINGS_FILE)
        return (st.st_mtime_ns, st.st_size)
    except OSError:
        return None


def load_settings() -> AppSettings:
    """Load settings from JSON file, returning defaults if not found. Never raises
    on a corrupt or version-mismatched file: a single bad settings.json must not
    brick boot (it is read at startup, by the settings endpoint, and per dispatch)."""
    global p_cached_settings, p_cached_sig
    sig = p_settings_sig()
    if sig is not None and p_cached_settings is not None and sig == p_cached_sig:
        return p_cached_settings.model_copy(deep=True)
    if os.path.exists(SETTINGS_FILE):
        try:
            with open(SETTINGS_FILE) as f:
                raw = json.load(f)
        except (json.JSONDecodeError, OSError, ValueError):
            p_preserve_corrupt_settings()
            return AppSettings()
        if not isinstance(raw, dict):
            # Valid JSON but not an object (e.g. a bare list/number); unusable.
            p_preserve_corrupt_settings()
            return AppSettings()
        settings = p_coerce_settings(migrate_legacy_fields(raw))
        if settings.default_system_prompt is None:
            settings.default_system_prompt = DEFAULT_SYSTEM_PROMPT
        p_cached_settings = settings.model_copy(deep=True)
        p_cached_sig = sig
        return settings
    return AppSettings()


# threading.Lock guards every SETTINGS_FILE write; works for sync paths and async run_in_executor paths.
p_settings_write_lock = threading.Lock()


def atomic_write_settings(payload: dict) -> None:
    """Atomic SETTINGS_FILE write; call via save_settings*, not directly."""
    global p_cached_settings, p_cached_sig
    with p_settings_write_lock:
        os.makedirs(DATA_DIR, exist_ok=True)
        fd, tmp = tempfile.mkstemp(prefix=".settings.", suffix=".tmp", dir=DATA_DIR)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(payload, f, indent=2)
            # Windows: Defender can briefly lock the destination; one retry handles every real case.
            for attempt in range(2):
                try:
                    os.replace(tmp, SETTINGS_FILE)
                    # Refresh the cache inside the lock so cache order matches disk order.
                    p_cached_settings = p_coerce_settings(migrate_legacy_fields(dict(payload)))
                    if p_cached_settings.default_system_prompt is None:
                        p_cached_settings.default_system_prompt = DEFAULT_SYSTEM_PROMPT
                    p_cached_sig = p_settings_sig()
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
    atomic_write_settings(settings_obj.model_dump())
