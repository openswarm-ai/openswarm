"""Fetch a published .swarm, with the host allowlist that keeps this from being an SSRF hole.

The catalog is a spreadsheet other people can edit, so a row's URL is untrusted input that would
otherwise make OUR backend fetch whatever it names, including localhost and cloud metadata. Every
hop of the redirect chain is checked, not just the first, because a permitted host may redirect.
"""

import logging
import os
import time
import urllib.error
import urllib.request
from typing import Callable, Optional
from urllib.parse import urlparse

from typeguard import typechecked

ALLOWED_DOWNLOAD_HOSTS = (
    "drive.google.com",
    "drive.usercontent.google.com",
    "docs.google.com",
    "github.com",
    "objects.githubusercontent.com",
    "raw.githubusercontent.com",
)

DOWNLOAD_TIMEOUT_SECONDS = 60
MAX_PACKAGE_BYTES = 200 * 1024 * 1024
CHUNK_BYTES = 64 * 1024
# Drill seam: cap the download at this many bytes per second so a human can watch the ring fill. Unset in real life.
THROTTLE_ENV = "OSW_MARKETPLACE_THROTTLE_BPS"

logger = logging.getLogger(__name__)

# (bytes received so far, total bytes or 0 when the server did not say)
ProgressCallback = Callable[[int, int], None]


class DownloadRefused(Exception):
    """The URL is not somewhere we are willing to fetch from."""


@typechecked
def host_allowed(url: str) -> bool:
    parsed = urlparse((url or "").strip())
    if parsed.scheme != "https" or not parsed.hostname:
        return False
    host = parsed.hostname.lower()
    return any(host == allowed or host.endswith("." + allowed) for allowed in ALLOWED_DOWNLOAD_HOSTS)


class AllowlistRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Drive answers a download with a redirect, so redirects have to be followed; each new
    location is re-checked so a permitted host cannot bounce us onto a private address."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[override]
        if not host_allowed(newurl):
            raise DownloadRefused(f"refused a redirect to {urlparse(newurl).hostname or newurl}")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


@typechecked
def throttle_bytes_per_second() -> int:
    raw = (os.environ.get(THROTTLE_ENV) or "").strip()
    if not raw:
        return 0
    try:
        bps = int(raw)
    except ValueError:
        return 0
    if bps > 0:
        logger.warning("marketplace downloads throttled to %d bytes/s by %s (drill seam)", bps, THROTTLE_ENV)
    return max(0, bps)


@typechecked
def declared_total(response: object) -> int:
    """Content-Length when the server sent one, else 0 (the ring then spins instead of filling)."""
    try:
        return max(0, int(response.headers.get("Content-Length") or 0))  # type: ignore[attr-defined]
    except (TypeError, ValueError):
        return 0


@typechecked
def download_package(url: str, on_progress: Optional[ProgressCallback] = None) -> bytes:
    """The bundle's bytes, or DownloadRefused. Never returns a partial or oversized body. Reads in
    chunks and reports (received, total) after each one so an install can show a real ring."""
    if not host_allowed(url):
        raise DownloadRefused("this package is not hosted somewhere OpenSwarm will download from")
    opener = urllib.request.build_opener(AllowlistRedirectHandler())
    request = urllib.request.Request(url, headers={"User-Agent": "OpenSwarm-Marketplace/1.0"})
    try:
        with opener.open(request, timeout=DOWNLOAD_TIMEOUT_SECONDS) as response:
            total = declared_total(response)
            if total > MAX_PACKAGE_BYTES:
                raise DownloadRefused("the package is too large")
            throttle = throttle_bytes_per_second()
            chunks: list[bytes] = []
            received = 0
            while True:
                chunk = response.read(CHUNK_BYTES)
                if not chunk:
                    break
                received += len(chunk)
                if received > MAX_PACKAGE_BYTES:
                    raise DownloadRefused("the package is too large")
                chunks.append(chunk)
                if on_progress is not None:
                    on_progress(received, total)
                if throttle:
                    time.sleep(len(chunk) / throttle)
            raw = b"".join(chunks)
    except urllib.error.HTTPError as e:
        raise DownloadRefused(f"the download returned {e.code}")
    except DownloadRefused:
        raise
    except Exception as e:
        raise DownloadRefused(f"the download failed: {e}")
    if len(raw) > MAX_PACKAGE_BYTES:
        raise DownloadRefused("the package is too large")
    if not raw:
        raise DownloadRefused("the download was empty")
    return raw


@typechecked
def package_filename(listing_id: str, title: str) -> str:
    base = (listing_id or title or "package").strip() or "package"
    return f"{base}.swarm"
