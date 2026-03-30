"""Backward-compatible shim — re-exports symbols that external modules import.

Preserves ``from backend.apps.tools_lib.tools_lib import ...`` used by
agent_manager.py, browser_agent.py, and main.py.
"""

from backend.apps.tools_lib import tools_lib  # noqa: F401 — SubApp
from backend.apps.tools_lib.routes import (  # noqa: F401
    _load_all, _save, _load,
    load_builtin_permissions, save_builtin_permissions,
)
from backend.apps.tools_lib.mcp_config import derive_mcp_config  # noqa: F401
from backend.apps.tools_lib.oauth import (  # noqa: F401
    refresh_oauth_token, refresh_google_token,
)
from backend.apps.common.mcp_utils import sanitize_server_name as _sanitize_server_name  # noqa: F401
