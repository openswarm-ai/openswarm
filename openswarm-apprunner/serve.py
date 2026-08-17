"""One process serves the published app: its own FastAPI backend at /api/* plus the built
frontend at /. Imported by uvicorn AFTER boot.py unpacked the bundle into /data/app."""
from backend.main import app
from fastapi.staticfiles import StaticFiles

app.mount("/", StaticFiles(directory="/data/app", html=True), name="frontend")
