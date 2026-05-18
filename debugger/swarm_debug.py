"""Re-exports debug() under swarm_debug; debug.py swaps sys.modules to the function so from-imports there don't work."""

import debug as _debug  # noqa: F401

debug = _debug

__all__ = ["debug"]
