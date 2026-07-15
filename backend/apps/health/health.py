from backend.config.Apps import SubApp
from contextlib import asynccontextmanager
from fastapi.responses import PlainTextResponse
from typeguard import typechecked
from fastapi import status, HTTPException

@asynccontextmanager
async def health_lifespan():
    yield

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