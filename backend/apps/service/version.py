"""App version resolution, isolated so it carries no SubApp/service deps.

Lives next to service.py (same directory), so the __file__-relative fallback
path to electron/package.json hops the same three dirnames up to the repo root.
"""

import json
import os


def read_app_version() -> str:
    # Preferred: Electron's main process injects this when spawning the backend (see electron/main.js; OPENSWARM_APP_VERSION). Always reliable in packaged builds because it comes from app.getVersion() rather than path-based file resolution.
    base = os.environ.get("OPENSWARM_APP_VERSION", "").strip()
    if not base:
        # Fallback: read electron/package.json via relative path. Works in `bash run.sh` dev mode where the repo layout is intact, but FAILS in packaged dmg/exe builds because electron/package.json isn't shipped into Resources/; which made every shipped install report app_version="unknown" pre-fix. Kept for backward compatibility with dev runs and as a safety net if the env var is ever unset.
        try:
            p_here = os.path.dirname(os.path.abspath(__file__))
            p_repo = os.path.dirname(os.path.dirname(os.path.dirname(p_here)))
            p_pkg = os.path.join(p_repo, "electron", "package.json")
            with open(p_pkg, encoding="utf-8") as p_f:
                base = json.load(p_f).get("version", "unknown")
        except (OSError, ValueError, KeyError):
            base = "unknown"
    # A dev/hackathon cohort (OPENSWARM_APP_CHANNEL=dev) reports e.g. "1.5.8-dev" so its events stay filterable from real installs; prod or unset keeps the bare version.
    channel = os.environ.get("OPENSWARM_APP_CHANNEL", "").strip().lower()
    if channel and channel != "prod":
        return f"{base}-{channel}"
    return base


APP_VERSION = read_app_version()
