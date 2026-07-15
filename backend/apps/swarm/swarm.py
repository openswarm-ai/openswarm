"""SubApp for .swarm sharing. Three endpoints: export (returns the bundle bytes
as a download), import/preflight (parse + stage in a sandbox, no writes), and
import/commit (write the staged entities with fresh ids). Staging is in-process
with a TTL; a lost token just means re-open the file."""
import logging
import shutil
import time
import uuid
from contextlib import asynccontextmanager

from fastapi import File, HTTPException, Response, UploadFile

from backend.config.Apps import SubApp

from backend.apps.swarm import closure
from backend.apps.swarm.models import (
    ExportPreflightResponse,
    ExportRequest,
    ImportCommitRequest,
    ImportCommitResponse,
    ImportPreflightResponse,
    RequirementView,
)
from backend.apps.swarm.ziputil import MAX_TOTAL_BYTES, BundleError

logger = logging.getLogger(__name__)

P_STAGING: dict[str, dict] = {}
P_STAGING_TTL = 30 * 60  # 30 minutes


def p_gc_staging() -> None:
    now = time.time()
    for token in list(P_STAGING):
        if now - P_STAGING[token]["created_at"] > P_STAGING_TTL:
            p_discard(token)


def p_discard(token: str) -> None:
    entry = P_STAGING.pop(token, None)
    if entry:
        shutil.rmtree(entry["sandbox"], ignore_errors=True)


@asynccontextmanager
async def swarm_lifespan():
    p_gc_staging()
    try:
        yield
    finally:
        for token in list(P_STAGING):
            p_discard(token)


swarm = SubApp("swarm", swarm_lifespan)


@swarm.router.post("/export/preflight")
async def export_preflight(body: ExportRequest) -> ExportPreflightResponse:
    try:
        manifest = closure.build_manifest(body.type, body.id)
    except BundleError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return ExportPreflightResponse(
        summary=closure.summarize(manifest),
        filename=closure.swarm_filename(manifest.root.name),
        link_supported=False,
    )


@swarm.router.post("/export")
async def export_bundle(body: ExportRequest) -> Response:
    try:
        raw, name = closure.build_bundle(body.type, body.id, allow_file_secrets=body.allow_secrets)
    except BundleError as e:
        raise HTTPException(status_code=400, detail=str(e))
    fname = closure.swarm_filename(name)
    return Response(
        content=raw,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


@swarm.router.post("/import/preflight")
async def import_preflight(file: UploadFile = File(...)) -> ImportPreflightResponse:
    raw = await file.read()
    if len(raw) > MAX_TOTAL_BYTES:
        raise HTTPException(status_code=400, detail="file is too large")
    try:
        sandbox, manifest, warnings = closure.stage_upload(raw, file.filename or "")
        conflicts = closure.detect_conflicts(sandbox, manifest)
        review = closure.review_bundle(sandbox, manifest)
    except BundleError as e:
        raise HTTPException(status_code=400, detail=str(e))
    p_gc_staging()
    token = uuid.uuid4().hex
    P_STAGING[token] = {"sandbox": sandbox, "manifest": manifest, "created_at": time.time()}
    return ImportPreflightResponse(
        summary=closure.summarize(manifest),
        staging_token=token,
        conflicts=conflicts,
        review=review,
        warnings=warnings,
    )


@swarm.router.post("/import/commit")
async def import_commit(body: ImportCommitRequest) -> ImportCommitResponse:
    entry = P_STAGING.get(body.staging_token)
    if not entry:
        raise HTTPException(status_code=404, detail="import session expired; please re-open the file")
    try:
        root_type, root_id, created, unresolved = closure.commit(
            entry["sandbox"], entry["manifest"], body.accept_requirements
        )
    except BundleError as e:
        raise HTTPException(status_code=400, detail=str(e))
    finally:
        p_discard(body.staging_token)
    if root_id is None:
        raise HTTPException(status_code=400, detail="bundle has no root entity")
    return ImportCommitResponse(
        root_type=root_type,
        root_id=root_id,
        created=created,
        unresolved_requirements=[
            RequirementView(kind=r.kind, key=r.key, label=r.label, detail=r.detail) for r in unresolved
        ],
    )
