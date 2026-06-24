"""Cloud client for the publish pipeline: ships the bundle to the host and takes
it back down. Reads the bearer directly (publish works for any signed-in account,
not just pro/free-trial), matching the cloud's requireAuthedUser gate."""
from __future__ import annotations

from typing import Optional

import httpx

from backend.apps.outputs.publish_common import PublishError
from backend.apps.settings.credentials import OPENSWARM_DEFAULT_PROXY_URL


def p_cloud_auth(settings) -> tuple[Optional[str], str]:
    base = (getattr(settings, "openswarm_proxy_url", None) or OPENSWARM_DEFAULT_PROXY_URL).rstrip("/")
    token = getattr(settings, "openswarm_bearer_token", None)
    return token, base


def p_safe_detail(resp: httpx.Response, fallback: str) -> str:
    try:
        body = resp.json()
        msg = body.get("message") or body.get("error")
        if isinstance(msg, str) and msg:
            return msg
    except Exception:
        pass
    return fallback


async def upload_to_cloud(
    settings, *, output_id: str, name: str, slug_hint: str, bundle: bytes, override: bool
) -> dict:
    token, base = p_cloud_auth(settings)
    if not token:
        raise PublishError("Sign in to your OpenSwarm account to publish apps.")
    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            r = await client.post(
                f"{base}/api/apps/publish",
                headers={"Authorization": f"Bearer {token}"},
                # output_id lets the cloud reuse this app's slug on republish instead
                # of minting a duplicate; override marks a publish past a non-clean scan.
                data={"name": name, "slug": slug_hint, "output_id": output_id, "override": "1" if override else "0"},
                files={"bundle": ("app.tar.gz", bundle, "application/gzip")},
            )
    except httpx.HTTPError:
        raise PublishError("Couldn't reach the publishing service. Check your connection and try again.")
    if r.status_code >= 400:
        raise PublishError(p_safe_detail(r, "Publishing failed. Please try again."))
    return r.json()


async def unpublish_from_cloud(settings, slug: str) -> None:
    token, base = p_cloud_auth(settings)
    if not token:
        raise PublishError("Sign in to your OpenSwarm account to manage published apps.")
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            r = await client.post(
                f"{base}/api/apps/{slug}/delete",
                headers={"Authorization": f"Bearer {token}"},
            )
    except httpx.HTTPError:
        raise PublishError("Couldn't reach the publishing service. Check your connection and try again.")
    if r.status_code >= 400 and r.status_code != 404:
        raise PublishError(p_safe_detail(r, "Couldn't unpublish. Please try again."))
