"""Fetch a published .swarm, with the host allowlist that keeps this from being an SSRF hole.

The catalog is a spreadsheet other people can edit, so a row's URL is untrusted input that would
otherwise make OUR backend fetch whatever it names, including localhost and cloud metadata. Every
hop of the redirect chain is checked, not just the first, because a permitted host may redirect.
"""

import urllib.error
import urllib.request
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
def download_package(url: str) -> bytes:
    """The bundle's bytes, or DownloadRefused. Never returns a partial or oversized body."""
    if not host_allowed(url):
        raise DownloadRefused("this package is not hosted somewhere OpenSwarm will download from")
    opener = urllib.request.build_opener(AllowlistRedirectHandler())
    request = urllib.request.Request(url, headers={"User-Agent": "OpenSwarm-Marketplace/1.0"})
    try:
        with opener.open(request, timeout=DOWNLOAD_TIMEOUT_SECONDS) as response:
            raw = response.read(MAX_PACKAGE_BYTES + 1)
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
