"""Honest degraded mode: the bundle could not be fetched (or has no backend); every request says
so instead of crash-looping the VM."""
from fastapi import FastAPI
from fastapi.responses import JSONResponse

app = FastAPI()


@app.get("/{path:path}")
async def unavailable(path: str) -> JSONResponse:
    return JSONResponse({"error": "this app's backend is not available right now"}, status_code=503)
