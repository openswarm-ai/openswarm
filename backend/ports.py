"""Centralized port configuration.

Reads from ports.config.json at the project root so every part of the
Python backend uses the same port numbers without hardcoding them.
"""

import json
import os

_config_path = os.path.join(os.path.dirname(__file__), "..", "ports.config.json")
with open(_config_path) as _f:
    _cfg = json.load(_f)

BACKEND_DEV_PORT: int = _cfg["backend"]["dev"]
BACKEND_PROD_PORT_START: int = _cfg["backend"]["prod"]["start"]
BACKEND_PROD_PORT_END: int = _cfg["backend"]["prod"]["end"]
FRONTEND_DEV_PORT: int = _cfg["frontend"]["dev"]
NINE_ROUTER_DEV_PORT: int = _cfg["nineRouter"]["dev"]
NINE_ROUTER_PROD_PORT: int = _cfg["nineRouter"]["prod"]


def _is_packaged() -> bool:
    return os.environ.get("OPENSWARM_PACKAGED") == "1"


def get_backend_port() -> int:
    """Return the active backend port (env override or dev default)."""
    return int(os.environ.get("OPENSWARM_PORT", str(BACKEND_DEV_PORT)))


def get_nine_router_port() -> int:
    """Return the 9Router port for the current environment."""
    return NINE_ROUTER_PROD_PORT if _is_packaged() else NINE_ROUTER_DEV_PORT


# Convenience alias — most callers just need the current port.
NINE_ROUTER_PORT: int = get_nine_router_port()
