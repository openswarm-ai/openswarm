"""An install as a job the pill can watch: download (with byte progress), stage, then hand back the
same review a dropped .swarm gets. The job lives in memory for a few minutes; a restart forgets it and
the pill simply asks again.
"""

import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Literal, Optional

from typeguard import typechecked

from backend.apps.marketplace.catalog import Listing
from backend.apps.marketplace.package_download import DownloadRefused, download_package, package_filename
from backend.apps.swarm.models import ImportPreflightResponse

JobPhase = Literal["downloading", "staging", "ready", "failed"]
JOB_TTL_SECONDS = 600


@dataclass
class InstallJob:
    id: str
    listing_id: str
    phase: JobPhase = "downloading"
    received: int = 0
    total: int = 0
    preflight: Optional[ImportPreflightResponse] = None
    error: Optional[str] = None
    started_at: float = field(default_factory=time.time)


P_JOBS: dict[str, InstallJob] = {}
P_LOCK = threading.Lock()


@typechecked
def start_job(listing_id: str) -> InstallJob:
    sweep_expired()
    job = InstallJob(id=uuid.uuid4().hex, listing_id=listing_id)
    with P_LOCK:
        P_JOBS[job.id] = job
    return job


@typechecked
def get_job(job_id: str) -> Optional[InstallJob]:
    with P_LOCK:
        return P_JOBS.get(job_id)


@typechecked
def sweep_expired(now: Optional[float] = None) -> int:
    cutoff = (now if now is not None else time.time()) - JOB_TTL_SECONDS
    with P_LOCK:
        stale = [job_id for job_id, job in P_JOBS.items() if job.started_at < cutoff]
        for job_id in stale:
            del P_JOBS[job_id]
    return len(stale)


@typechecked
def run_job(job: InstallJob, listing: Listing) -> None:
    """Runs on a worker thread. Every exit lands the job in ready or failed; nothing is left spinning."""

    def on_progress(received: int, total: int) -> None:
        job.received = received
        job.total = total

    try:
        raw = download_package(listing.download_url, on_progress)
        job.phase = "staging"
        # Staging is local and quick; the ring reads as full while it runs.
        from backend.apps.swarm.swarm import stage_bundle_for_import
        job.preflight = stage_bundle_for_import(raw, package_filename(listing.id, listing.title))
        job.phase = "ready"
    except DownloadRefused as e:
        job.error = str(e)
        job.phase = "failed"
    except Exception as e:
        job.error = f"Couldn't install it: {e}"
        job.phase = "failed"
