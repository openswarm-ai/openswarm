"""The marketplace catalog: a public Google Sheet read as CSV and normalized into listings.

The sheet is the publisher's surface, so a package appears by adding a row and needs no OpenSwarm
deploy and no credential. Drive share links are rewritten to direct-download form because a share
link serves an HTML page, not the bundle.
"""

import csv
import io
import os
import re
import time
import urllib.request
from typing import Dict, List, Optional

from pydantic import BaseModel, ConfigDict, Field
from typeguard import typechecked

# The published catalog. Overridable so a fork or a staging sheet can be pointed at without a build.
DEFAULT_SHEET_ID = "1HInP47Vj-daPYKIl02YrAbyKsX1GQ_FSPSm_YF2QIWw"
SHEET_ID_ENV = "OPENSWARM_MARKETPLACE_SHEET_ID"

CACHE_TTL_SECONDS = 600
FETCH_TIMEOUT_SECONDS = 15
# A sheet is text; anything this large is a wrong URL answering, not a catalog.
MAX_SHEET_BYTES = 4 * 1024 * 1024

P_SHEET_ID_RE = re.compile(r"/spreadsheets/d/([A-Za-z0-9_-]+)")
P_DRIVE_ID_RE = re.compile(r"(?:/d/|id=)([A-Za-z0-9_-]{20,})")


class Listing(BaseModel):
    """One row of the sheet. Every field is a string because a spreadsheet cell is a string, and a
    publisher leaving one blank must never break the catalog for everyone else."""

    model_config = ConfigDict(validate_assignment=True)

    id: str
    title: str = ""
    kind: str = ""
    version: str = ""
    author: str = ""
    description: str = ""
    tags: str = ""
    download_url: str = ""
    icon_url: str = ""
    video_url: str = ""
    size: str = ""
    updated_at: str = ""
    # A bundle groups already-published listings; this holds their comma-separated ids.
    bundle_items: str = ""
    # The publisher's long-form page, converted to our block JSON at publish time.
    notion_url: str = ""
    details_json: str = ""


class CatalogResponse(BaseModel):
    model_config = ConfigDict(validate_assignment=True)

    source: str
    count: int
    listings: List[Listing] = Field(default_factory=list)
    error: str = ""
    fetched_at: float = 0.0


KNOWN_FIELDS = tuple(Listing.model_fields.keys())

p_cache: Optional[CatalogResponse] = None


@typechecked
def sheet_id() -> str:
    """The configured sheet, accepting either a raw id or a pasted sheet URL."""
    raw = (os.environ.get(SHEET_ID_ENV) or "").strip() or DEFAULT_SHEET_ID
    match = P_SHEET_ID_RE.search(raw)
    return match.group(1) if match else raw


@typechecked
def csv_export_url(sid: str) -> str:
    return f"https://docs.google.com/spreadsheets/d/{sid}/export?format=csv"


@typechecked
def normalize_download_url(url: str) -> str:
    """A Drive share link serves a viewer page; the installer needs the bytes."""
    url = (url or "").strip()
    if not url or "drive.google.com" not in url:
        return url
    match = P_DRIVE_ID_RE.search(url)
    return f"https://drive.google.com/uc?export=download&id={match.group(1)}" if match else url


@typechecked
def normalize_video_url(url: str) -> str:
    """Drive video links are stored in several hand-pasted shapes; keep one embeddable form."""
    url = (url or "").strip()
    if not url or "drive.google.com" not in url or "/preview" in url:
        return url
    match = P_DRIVE_ID_RE.search(url)
    return f"https://drive.google.com/file/d/{match.group(1)}/preview" if match else url


@typechecked
def normalize_video_field(raw: str) -> str:
    """One cell can carry several demo videos, one URL per line, primary first."""
    lines = [normalize_video_url(line) for line in re.split(r"[\r\n]+", raw or "") if line.strip()]
    return "\n".join(line for line in lines if line)


@typechecked
def slug_from_title(title: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")


@typechecked
def parse_csv(text: str) -> List[Listing]:
    """Rows the sheet's own header names, loosely matched so a sloppy header still parses. Unknown
    columns are ignored rather than rejected, so a publisher can add their own without a release."""
    listings: List[Listing] = []
    for row in csv.DictReader(io.StringIO(text)):
        norm: Dict[str, str] = {
            (key or "").strip().lower().replace(" ", "_"): (value or "").strip()
            for key, value in row.items()
            if key
        }
        values = {field: norm.get(field, "") for field in KNOWN_FIELDS}
        if not values["id"] and not values["title"]:
            continue
        if not values["id"]:
            values["id"] = slug_from_title(values["title"])
        if not values["id"]:
            continue
        values["download_url"] = normalize_download_url(values["download_url"])
        values["video_url"] = normalize_video_field(values["video_url"])
        listings.append(Listing(**values))
    return listings


@typechecked
def fetch_sheet_csv(url: str) -> str:
    """Stdlib only: this runs on end-user machines, and the sheet is public so there is no auth."""
    request = urllib.request.Request(url, headers={"User-Agent": "OpenSwarm-Marketplace/1.0"})
    with urllib.request.urlopen(request, timeout=FETCH_TIMEOUT_SECONDS) as response:
        raw = response.read(MAX_SHEET_BYTES + 1)
        if len(raw) > MAX_SHEET_BYTES:
            raise ValueError("catalog response is too large to be a sheet")
        charset = response.headers.get_content_charset() or "utf-8"
        return raw.decode(charset, errors="replace")


@typechecked
def load_catalog(force: bool = False) -> CatalogResponse:
    """The catalog, from cache when fresh. A failed fetch serves the last good copy rather than an
    empty store, and says so, because a flaky network must not look like an empty marketplace."""
    global p_cache
    now = time.time()
    if not force and p_cache is not None and now - p_cache.fetched_at < CACHE_TTL_SECONDS:
        return p_cache
    try:
        listings = parse_csv(fetch_sheet_csv(csv_export_url(sheet_id())))
    except Exception as e:
        if p_cache is not None:
            return p_cache.model_copy(update={"source": "cache", "error": f"Could not refresh the catalog: {e}"})
        return CatalogResponse(source="empty", count=0, listings=[], error=f"Could not reach the catalog: {e}", fetched_at=now)
    p_cache = CatalogResponse(source="sheet", count=len(listings), listings=listings, fetched_at=now)
    return p_cache


@typechecked
def find_listing(listing_id: str) -> Optional[Listing]:
    """Resolve an id against OUR fetched catalog; a caller never gets to name a URL to fetch."""
    wanted = (listing_id or "").strip()
    for listing in load_catalog().listings:
        if listing.id == wanted:
            return listing
    return None
