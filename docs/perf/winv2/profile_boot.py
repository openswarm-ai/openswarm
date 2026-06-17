"""Per-phase + per-SubApp-lifespan boot profiler (winv2).

Warm import is ~1.3s but backend-http-ready is ~9-10s, so the gap is the
lifespan startup (SubApp lifespans are entered sequentially in config/Apps.py
before uvicorn serves). This times each one to find what blocks the HTTP bind.

Run with the bundled interpreter from the resources dir, e.g.:
  python-env/python.exe docs/perf/winv2/profile_boot.py
It spawns the same subprocesses a real boot does (9router etc.); the
AsyncExitStack unwinds at the end. Kill any straggler node/9router after.
"""
import asyncio
import os
import time

os.environ.setdefault("OPENSWARM_AUTH_TOKEN", "x")

_t0 = time.perf_counter()
import backend.main  # noqa: F401  (builds main_app; full import tree)
_import_ms = (time.perf_counter() - _t0) * 1000

from contextlib import AsyncExitStack  # noqa: E402

from backend.apps.health.health import health  # noqa: E402
from backend.apps.agents.agents import agents  # noqa: E402
from backend.apps.skills.skills import skills  # noqa: E402
from backend.apps.tools_lib.tools_lib import tools_lib  # noqa: E402
from backend.apps.modes.modes import modes  # noqa: E402
from backend.apps.settings.settings import settings  # noqa: E402
from backend.apps.mcp_registry.mcp_registry import mcp_registry  # noqa: E402
from backend.apps.skill_registry.skill_registry import skill_registry  # noqa: E402
from backend.apps.outputs.outputs import outputs  # noqa: E402
from backend.apps.dashboards.dashboards import dashboards  # noqa: E402
from backend.apps.swarm.swarm import swarm  # noqa: E402
from backend.apps.service.service import service  # noqa: E402
from backend.apps.subscription.router import subscription  # noqa: E402
from backend.apps.auth.router import auth  # noqa: E402
from backend.apps.web.web import web  # noqa: E402
from backend.apps.agents.proxy.anthropic_proxy import anthropic_proxy  # noqa: E402

SUBS = [health, agents, skills, tools_lib, modes, settings, mcp_registry,
        skill_registry, outputs, dashboards, swarm, service, subscription,
        auth, web, anthropic_proxy]


async def main():
    print(f"{_import_ms:8.0f} ms  import backend.main (full tree)")
    print("-" * 48)
    total = 0.0
    async with AsyncExitStack() as stack:
        for s in SUBS:
            t = time.perf_counter()
            try:
                await asyncio.wait_for(stack.enter_async_context(s.lifespan()), timeout=60)
            except Exception as e:
                print(f"   ERR    lifespan {s.name}: {type(e).__name__}")
                continue
            dt = (time.perf_counter() - t) * 1000
            total += dt
            print(f"{dt:8.0f} ms  lifespan {s.name}")
        print("-" * 48)
        print(f"{total:8.0f} ms  all lifespans")
        print(f"{_import_ms + total:8.0f} ms  import + lifespans (approx backend-ready floor)")


if __name__ == "__main__":
    asyncio.run(main())
