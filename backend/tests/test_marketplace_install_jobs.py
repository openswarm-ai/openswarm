"""An install is a job the pill can watch: the download streams and reports bytes, the job walks
downloading -> staging -> ready (or failed) and nothing is left spinning, and the routes expose it."""

import io
import time
from typing import Any

from backend.apps.marketplace import install_jobs, package_download
from backend.apps.marketplace.catalog import Listing
from backend.apps.marketplace.package_download import DownloadRefused, download_package


class P_Response:
    def __init__(self, body: bytes, content_length: Any) -> None:
        self.headers = {"Content-Length": content_length}
        self._buf = io.BytesIO(body)

    def read(self, n: int) -> bytes:
        return self._buf.read(n)

    def __enter__(self) -> "P_Response":
        return self

    def __exit__(self, *exc: object) -> None:
        return None


class P_Opener:
    def __init__(self, response: P_Response) -> None:
        self.response = response

    def open(self, request: object, timeout: float) -> P_Response:
        return self.response


def p_fake_opener(monkeypatch: Any, body: bytes, content_length: Any) -> None:
    monkeypatch.setattr(package_download.urllib.request, "build_opener", lambda *a, **k: P_Opener(P_Response(body, content_length)))


def test_the_download_reports_bytes_after_every_chunk_and_ends_on_the_total(monkeypatch: Any) -> None:
    body = b"x" * (package_download.CHUNK_BYTES * 2 + 17)
    p_fake_opener(monkeypatch, body, str(len(body)))
    seen: list[tuple[int, int]] = []
    raw = download_package("https://github.com/o/r/releases/download/v1/p.swarm", lambda r, t: seen.append((r, t)))
    assert raw == body
    assert [r for r, _ in seen] == [package_download.CHUNK_BYTES, package_download.CHUNK_BYTES * 2, len(body)]
    assert {t for _, t in seen} == {len(body)}


def test_no_content_length_means_total_zero_and_the_bytes_still_arrive(monkeypatch: Any) -> None:
    p_fake_opener(monkeypatch, b"abc", None)
    seen: list[tuple[int, int]] = []
    assert download_package("https://github.com/o/r/p.swarm", lambda r, t: seen.append((r, t))) == b"abc"
    assert seen == [(3, 0)]


def test_an_oversized_declaration_is_refused_before_a_byte_is_read(monkeypatch: Any) -> None:
    p_fake_opener(monkeypatch, b"", str(package_download.MAX_PACKAGE_BYTES + 1))
    try:
        download_package("https://github.com/o/r/p.swarm")
    except DownloadRefused as e:
        assert "too large" in str(e)
    else:
        raise AssertionError("an oversized package was downloaded")


def test_a_job_walks_downloading_staging_ready_with_the_review(monkeypatch: Any) -> None:
    listing = Listing(id="git-graph", title="Git Graph", download_url="https://github.com/o/r/p.swarm")
    monkeypatch.setattr(install_jobs, "download_package", lambda url, cb: (cb(5, 10), cb(10, 10), b"bundle")[-1])
    import backend.apps.swarm.swarm as p_swarm
    from backend.apps.swarm.models import BundleSummary, ImportPreflightResponse
    monkeypatch.setattr(p_swarm, "stage_bundle_for_import", lambda raw, fn: ImportPreflightResponse.model_construct(summary=BundleSummary.model_construct(), staging_token="tok-" + fn))
    job = install_jobs.start_job(listing.id)
    install_jobs.run_job(job, listing)
    assert job.phase == "ready"
    assert (job.received, job.total) == (10, 10)
    assert job.preflight is not None and job.preflight.staging_token == "tok-git-graph.swarm"
    assert install_jobs.get_job(job.id) is job


def test_a_refused_download_lands_the_job_in_failed_with_the_reason(monkeypatch: Any) -> None:
    listing = Listing(id="x", title="X", download_url="https://github.com/o/r/p.swarm")

    def refuse(url: str, cb: Any) -> bytes:
        raise DownloadRefused("the download returned 404")

    monkeypatch.setattr(install_jobs, "download_package", refuse)
    job = install_jobs.start_job(listing.id)
    install_jobs.run_job(job, listing)
    assert job.phase == "failed"
    assert job.error == "the download returned 404"


def test_jobs_expire_so_the_store_cannot_grow_forever() -> None:
    job = install_jobs.start_job("old")
    job.started_at = time.time() - install_jobs.JOB_TTL_SECONDS - 1
    assert install_jobs.sweep_expired() >= 1
    assert install_jobs.get_job(job.id) is None


def test_the_routes_start_a_job_and_report_it(monkeypatch: Any) -> None:
    from fastapi.testclient import TestClient
    from backend.apps.marketplace import marketplace as p_mp

    listing = Listing(id="git-graph", title="Git Graph", download_url="https://github.com/o/r/p.swarm")
    monkeypatch.setattr(p_mp.catalog, "find_listing", lambda listing_id: listing if listing_id == "git-graph" else None)
    monkeypatch.setattr(p_mp, "run_job", lambda job, lst: setattr(job, "phase", "failed") or setattr(job, "error", "the download returned 404"))
    from fastapi import FastAPI
    app = FastAPI()
    app.include_router(p_mp.marketplace.router, prefix="/api/marketplace")
    client = TestClient(app)
    assert client.post("/api/marketplace/install/start", json={"id": "nope"}).status_code == 404
    started = client.post("/api/marketplace/install/start", json={"id": "git-graph"})
    assert started.status_code == 200
    job_id = started.json()["job_id"]
    for _ in range(50):
        status = client.get(f"/api/marketplace/install/{job_id}").json()
        if status["phase"] == "failed":
            break
        time.sleep(0.02)
    assert status["phase"] == "failed" and status["error"] == "the download returned 404"
    assert client.get("/api/marketplace/install/does-not-exist").status_code == 404
