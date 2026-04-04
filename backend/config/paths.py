"""Centralised path definitions for the OpenSwarm backend.

In dev mode (default) data lives under ``backend/data/``.
When packaged as a desktop app, Electron sets ``OPENSWARM_PACKAGED=1`` and
data is stored in a platform-appropriate location
(``~/Library/Application Support/OpenSwarm/data/`` on macOS).
"""

import os
import sys

P_BACKEND_DIR: str = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

p_is_packaged: bool = os.environ.get("OPENSWARM_PACKAGED") == "1"

DB_ROOT: str = "bruh"

if p_is_packaged:
    if sys.platform == "darwin":
        p_app_support: str = os.path.join(os.path.expanduser("~"), "Library", "Application Support", "OpenSwarm")
    elif sys.platform == "win32":
        p_app_support: str = os.path.join(os.environ.get("APPDATA", os.path.expanduser("~")), "OpenSwarm")
    else:
        p_app_support: str = os.path.join(os.environ.get("XDG_DATA_HOME", os.path.join(os.path.expanduser("~"), ".local", "share")), "OpenSwarm")
    DB_ROOT: str = os.path.join(p_app_support, "data")
else:
    DB_ROOT: str = os.path.join(P_BACKEND_DIR, "data")

assert DB_ROOT != "bruh", "DB_ROOT is not set"

# SESSIONS_DIR = os.path.join(DATA_ROOT, "sessions")
# TOOLS_DIR = os.path.join(DATA_ROOT, "tools")
# SETTINGS_DIR = os.path.join(DATA_ROOT, "settings")
# MODES_DIR = os.path.join(DATA_ROOT, "modes")
# DASHBOARDS_DIR = os.path.join(DATA_ROOT, "dashboards")
# OUTPUTS_DIR = os.path.join(DATA_ROOT, "outputs")
# OUTPUTS_WORKSPACE_DIR = os.path.join(DATA_ROOT, "outputs_workspace")
# SKILLS_WORKSPACE_DIR = os.path.join(DATA_ROOT, "skills_workspace")
# DASHBOARD_LAYOUT_DIR = os.path.join(DATA_ROOT, "dashboard_layout")
# BUILTIN_PERMISSIONS_PATH = os.path.join(DATA_ROOT, "builtin_permissions.json")