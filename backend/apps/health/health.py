from backend.config.Apps import SubApp
from contextlib import asynccontextmanager
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, ConfigDict
from typeguard import typechecked
from fastapi import status, HTTPException

@asynccontextmanager
async def health_lifespan():
    # Out-of-loop liveness backstop (hermes #66892 lift): every other watchdog here is an asyncio
    # task that a wedged loop can never run; this one is a plain OS thread that hard-exits a
    # provably frozen backend so Electron's respawn produces a working process. Fails open.
    import asyncio
    from backend.apps.system.loop_liveness_watchdog import start_loop_liveness_watchdog
    p_stop = start_loop_liveness_watchdog(asyncio.get_running_loop())
    try:
        yield
    finally:
        if p_stop is not None:
            p_stop.set()

health = SubApp("health", health_lifespan)

@health.router.get("/check")
@typechecked
async def check() -> PlainTextResponse:
    return PlainTextResponse(
        content="OK",
        status_code=status.HTTP_200_OK,
        headers={
            "Content-Type": "text/plain",
            "Content-Length": "2"
        }
    )


class RendererHealth(BaseModel):
    """Whether an Electron window is driving this backend, which is what makes browser tools real."""

    model_config = ConfigDict(validate_assignment=True)

    attached: bool
    ever_attached: bool
    connections: int


@health.router.get("/renderer")
@typechecked
async def renderer() -> RendererHealth:
    """Renderer readiness. The cloud runner blocks on this before it fires a workflow, because a
    browser step with no window behind it burns turns narrating timeouts at nothing."""
    from backend.apps.agents.core.ws_manager import ws_manager
    return RendererHealth(
        attached=bool(ws_manager.global_connections),
        ever_attached=ws_manager.renderer_ever_attached,
        connections=len(ws_manager.global_connections),
    )
