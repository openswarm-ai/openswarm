"""FastAPI routes for the .swarm portable bundle feature."""

import logging
from contextlib import asynccontextmanager

from fastapi import HTTPException, UploadFile, File, Form
from fastapi.responses import Response

from backend.config.Apps import SubApp
from backend.apps.portable.exporter import build_swarm_bundle
from backend.apps.portable.importer import (
    preview_swarm_bundle,
    install_swarm_bundle,
    BundleError,
)

logger = logging.getLogger(__name__)


@asynccontextmanager
async def portable_lifespan():
    yield


portable = SubApp("portable", portable_lifespan)


@portable.router.get("/export/dashboard/{dashboard_id}")
async def export_dashboard(dashboard_id: str):
    """Build a .swarm file for *dashboard_id* and return it as a download."""
    try:
        data, filename = build_swarm_bundle(dashboard_id)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        logger.exception("export failed")
        raise HTTPException(status_code=500, detail=str(e))

    return Response(
        content=data,
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
        },
    )


@portable.router.post("/import/preview")
async def import_preview(file: UploadFile = File(...)):
    """Phase 1: parse the uploaded .swarm file and return its manifest + conflicts."""
    data = await file.read()
    try:
        return preview_swarm_bundle(data)
    except BundleError as e:
        raise HTTPException(status_code=400, detail=str(e))


@portable.router.post("/import/install")
async def import_install(
    file: UploadFile = File(...),
    env: str = Form("{}"),
    conflicts: str = Form("{}"),
):
    """Phase 2: install the uploaded bundle.

    *env* and *conflicts* are JSON-encoded dicts.
    """
    import json as _json
    try:
        env_dict = _json.loads(env) if env else {}
        conflicts_dict = _json.loads(conflicts) if conflicts else {}
    except _json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="env and conflicts must be JSON objects")

    data = await file.read()
    try:
        return install_swarm_bundle(data, env=env_dict, conflicts=conflicts_dict)
    except BundleError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("install failed")
        raise HTTPException(status_code=500, detail=str(e))
