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
from backend.apps.marketplace.package_download import (
    DownloadRefused,
    download_package,
    package_filename,
)
from backend.apps.swarm.models import ImportPreflightResponse
from backend.apps.swarm.swarm import stage_bundle_for_import
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


@marketplace.router.post("/install/preflight")
async def install_preflight(body: InstallRequest) -> ImportPreflightResponse:
    """Download the listing's bundle and stage it for the ordinary import confirm flow."""
    listing = await asyncio.to_thread(catalog.find_listing, body.id)
    if listing is None:
        raise HTTPException(status_code=404, detail="that package is not in the catalog any more")
    if not listing.download_url:
        raise HTTPException(status_code=400, detail="this listing has no package file yet")
    try:
        raw = await asyncio.to_thread(download_package, listing.download_url)
    except DownloadRefused as e:
        logger.warning("marketplace download refused for %s: %s", listing.id, e)
        raise HTTPException(status_code=400, detail=str(e))
    return stage_bundle_for_import(raw, package_filename(listing.id, listing.title))
