"""Marketplace routes: browse the published catalog, and stage a package for install.

Install deliberately owns no writing of its own. It downloads the bundle and hands the bytes to the
same staging door a dropped .swarm goes through, so the conflict check, the secret review and the
"a skill never installs silently" rule are the ones already shipped, not a second copy that can
drift away from them.
"""

import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict

from backend.apps.marketplace import catalog
from backend.apps.marketplace.install_jobs import InstallJob, JobPhase, get_job, run_job, start_job
from backend.apps.marketplace.installs import InstallRecord, load_installs, record_install
from backend.apps.swarm.models import ImportPreflightResponse
from backend.config.Apps import SubApp

logger = logging.getLogger(__name__)


class InstallRequest(BaseModel):
    model_config = ConfigDict(validate_assignment=True)

    id: str


@asynccontextmanager
async def marketplace_lifespan():
    yield


marketplace = SubApp("marketplace", marketplace_lifespan)


@marketplace.router.get("/listings")
async def get_listings(refresh: bool = False) -> catalog.CatalogResponse:
    """The published catalog. Never raises: an unreachable sheet answers with the last good copy
    and an error string, because a browse surface that 500s reads as "the marketplace is gone"."""
    return await asyncio.to_thread(catalog.load_catalog, refresh)


class InstallStartResponse(BaseModel):
    model_config = ConfigDict(validate_assignment=True)

    job_id: str


class InstallJobStatus(BaseModel):
    model_config = ConfigDict(validate_assignment=True)

    job_id: str
    phase: JobPhase
    received: int
    total: int
    preflight: ImportPreflightResponse | None = None
    error: str | None = None


def job_status(job: InstallJob) -> InstallJobStatus:
    return InstallJobStatus(job_id=job.id, phase=job.phase, received=job.received, total=job.total, preflight=job.preflight, error=job.error)


# Fire-and-forget tasks need a reference or the loop may drop them mid-download.
P_RUNNING: set[asyncio.Task[None]] = set()


@marketplace.router.post("/install/start")
async def install_start(body: InstallRequest) -> InstallStartResponse:
    """Start downloading the listing's bundle; the job stages it for the ordinary import confirm
    flow and the pill polls /install/{job_id} for byte progress and the review."""
    listing = await asyncio.to_thread(catalog.find_listing, body.id)
    if listing is None:
        raise HTTPException(status_code=404, detail="that package is not in the catalog any more")
    if not listing.download_url:
        raise HTTPException(status_code=400, detail="this listing has no package file yet")
    job = start_job(listing.id)
    task = asyncio.create_task(asyncio.to_thread(run_job, job, listing))
    P_RUNNING.add(task)
    task.add_done_callback(P_RUNNING.discard)
    return InstallStartResponse(job_id=job.id)


@marketplace.router.get("/install/{job_id}")
async def install_status(job_id: str) -> InstallJobStatus:
    job = get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="that install is no longer running; start it again")
    if job.phase == "failed":
        logger.warning("marketplace install failed for %s: %s", job.listing_id, job.error)
    return job_status(job)


class InstallsResponse(BaseModel):
    model_config = ConfigDict(validate_assignment=True)

    installs: dict[str, InstallRecord]


@marketplace.router.get("/installed")
async def get_installed() -> InstallsResponse:
    return InstallsResponse(installs=load_installs())


@marketplace.router.post("/installed")
async def post_installed(body: InstallRecord) -> InstallsResponse:
    if not body.listing_id or not body.root_type or not body.root_id():
        raise HTTPException(status_code=400, detail="listing_id, root_type and the id of what was installed are required")
    return InstallsResponse(installs=record_install(body))
