"""Module alias — exposes the `debug()` function under the `swarm_debug`
name so code that does `from swarm_debug import debug` resolves to the
same OpenSwarm-bundled package that the legacy `import debug` path
already serves.

`debug.py` ends with `sys.modules[__name__] = debug`, which replaces the
module object with the bare function. That trick lets OpenSwarm's own
code write `import debug; debug(x)` (the imported name binds to the
function directly), but it means `from debug import debug` doesn't work
(you can't attribute-walk a function). This shim captures the function
via `import debug` (which now binds to the function thanks to the
sys.modules swap) and re-exports it as a normal module attribute, so
the more conventional `from swarm_debug import debug` pattern works.
"""

import debug as _debug  # noqa: F401 — `_debug` is actually the function

# Re-export as a module attribute so `from swarm_debug import debug` resolves.
debug = _debug

__all__ = ["debug"]
