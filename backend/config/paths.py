"""Centralised path definitions for the OpenSwarm backend.

In dev mode (default) data lives under ``backend/data/``.
When packaged as a desktop app, Electron sets ``OPENSWARM_PACKAGED=1`` and
data is stored in a platform-appropriate location
(``~/Library/Application Support/OpenSwarm/data/`` on macOS).
"""

import os
import sys

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

_is_packaged = os.environ.get("OPENSWARM_PACKAGED") == "1"

if _is_packaged:
    if sys.platform == "darwin":
        _app_support = os.path.join(os.path.expanduser("~"), "Library", "Application Support", "OpenSwarm")
    elif sys.platform == "win32":
        _app_support = os.path.join(os.environ.get("APPDATA", os.path.expanduser("~")), "OpenSwarm")
    else:
        _app_support = os.path.join(os.environ.get("XDG_DATA_HOME", os.path.join(os.path.expanduser("~"), ".local", "share")), "OpenSwarm")
    DATA_ROOT = os.path.join(_app_support, "data")
else:
    DATA_ROOT = os.path.join(_BACKEND_DIR, "data")

SESSIONS_DIR = os.path.join(DATA_ROOT, "sessions")
TOOLS_DIR = os.path.join(DATA_ROOT, "tools")
SETTINGS_DIR = os.path.join(DATA_ROOT, "settings")
MODES_DIR = os.path.join(DATA_ROOT, "modes")
TEMPLATES_DIR = os.path.join(DATA_ROOT, "templates")
DASHBOARDS_DIR = os.path.join(DATA_ROOT, "dashboards")
OUTPUTS_DIR = os.path.join(DATA_ROOT, "outputs")
OUTPUTS_WORKSPACE_DIR = os.path.join(DATA_ROOT, "outputs_workspace")
SKILLS_WORKSPACE_DIR = os.path.join(DATA_ROOT, "skills_workspace")
DASHBOARD_LAYOUT_DIR = os.path.join(DATA_ROOT, "dashboard_layout")
BUILTIN_PERMISSIONS_PATH = os.path.join(DATA_ROOT, "builtin_permissions.json")
CHANNELS_DIR = os.path.join(DATA_ROOT, "channels")
CHANNELS_SESSIONS_DIR = os.path.join(DATA_ROOT, "channels", "sessions")
ANALYTICS_DIR = os.path.join(DATA_ROOT, "analytics")

BACKEND_DIR = _BACKEND_DIR
