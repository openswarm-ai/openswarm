"""App version resolution, isolated so it carries no SubApp/service deps.

Lives next to service.py (same directory), so the __file__-relative fallback
path to electron/package.json hops the same three dirnames up to the repo root.
"""

import json
import os


def _read_app_version() -> str:
    # Preferred: Electron's main process injects this when spawning the
    # backend (see electron/main.js; OPENSWARM_APP_VERSION). Always reliable
    # in packaged builds because it comes from app.getVersion() rather than
    # path-based file resolution.
    env_v = os.environ.get("OPENSWARM_APP_VERSION", "").strip()
    if env_v:
        return env_v
    # Fallback: read electron/package.json via relative path. Works in
    # `bash run.sh` dev mode where the repo layout is intact, but FAILS in
    # packaged dmg/exe builds because electron/package.json isn't shipped
    # into Resources/; which made every shipped install report
    # app_version="unknown" pre-fix. Kept for backward compatibility with
    # dev runs and as a safety net if the env var is ever unset.
    try:
        _here = os.path.dirname(os.path.abspath(__file__))
        _repo = os.path.dirname(os.path.dirname(os.path.dirname(_here)))
        _pkg = os.path.join(_repo, "electron", "package.json")
        with open(_pkg, encoding="utf-8") as _f:
            return json.load(_f).get("version", "unknown")
    except (OSError, ValueError, KeyError):
        return "unknown"


APP_VERSION = _read_app_version()
