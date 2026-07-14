"""openswarm-edge: the public face of {slug}.openswarm.host.

This service is intentionally the LEAST-privileged of the three: it holds only a
read-only Tigris key + EDGE_AUTH_TOKEN. It serves static app bundles, runs the
sandboxed backend.py compute locally, and proxies runtime LLM calls to the cloud
(which owns creator attribution, budgets, and pool credentials). The published
page only ever talks to its own origin; the slug is derived here from the Host
header and stamped on the internal call, so a page can never bill or impersonate
another app."""
from __future__ import annotations

import os
import re

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse, Response, StreamingResponse

from .bundles import get_bundle, resolve_file
from .fallback import apex_page, not_found_page
from .inject import inject_runtime
from .ratelimit import RateLimiter
from .sandbox import UnsafeCodeError, run_backend

APPS_BASE_DOMAIN = os.environ.get("APPS_BASE_DOMAIN", "openswarm.host")
# The metered-LLM call goes to the cloud over Fly's PRIVATE 6PN mesh (encrypted,
# same-org only), so it never traverses the public internet. Falls back to the
# public URL only if the internal one isn't configured (e.g. local dev).
CLOUD_INTERNAL_URL = os.environ.get(
    "OPENSWARM_CLOUD_INTERNAL_URL", "http://openswarm-cloud.internal:8080"
).rstrip("/")
EDGE_AUTH_TOKEN = os.environ.get("EDGE_AUTH_TOKEN", "")
EDGE_PUBLIC_HOST = os.environ.get(
    "EDGE_PUBLIC_HOST", f"{os.environ.get('FLY_APP_NAME', 'openswarm-edge')}.fly.dev"
).lower()

_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,31}$")
_DOWNLOAD_FILENAME_RE = re.compile(r"^[A-Za-z0-9._-]{1,180}$")
_llm_limiter = RateLimiter(limit=30, window_seconds=60)
_compute_limiter = RateLimiter(limit=60, window_seconds=60)
_download_limiter = RateLimiter(limit=30, window_seconds=60)

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)


def slug_from_host(host: str) -> str | None:
    """Extract the app slug from a {slug}.openswarm.host Host header. Rejects the
    apex, www, multi-label subdomains, and anything not slug-shaped."""
    host = (host or "").split(":")[0].lower()
    suffix = "." + APPS_BASE_DOMAIN
    if not host.endswith(suffix):
        return None
    sub = host[: -len(suffix)]
    if not sub or "." in sub or sub == "www":
        return None
    return sub if _SLUG_RE.match(sub) else None


def client_ip(request: Request) -> str:
    return request.headers.get("fly-client-ip") or (request.client.host if request.client else "unknown")


def _security_headers() -> dict[str, str]:
    # The hard isolation is the separate apex (no openswarm.com cookies are reachable
    # here). CSP is defense-in-depth: block embedding + sniffing. We deliberately do
    # NOT lock script/connect-src, arbitrary apps need to run their own JS and call
    # their own APIs; the pre-publish scan is what screens for abusive content.
    return {
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "frame-ancestors 'none'",
        "Referrer-Policy": "no-referrer-when-downgrade",
        "Cache-Control": "public, max-age=60",
    }


@app.get("/__edge/health")
async def health() -> JSONResponse:
    return JSONResponse({"ok": True})


@app.post("/__compute")
async def edge_compute(request: Request) -> Response:
    slug = slug_from_host(request.headers.get("host", ""))
    if not slug:
        return JSONResponse({"error": "unknown app"}, status_code=404)
    if not _compute_limiter.allow(client_ip(request)):
        return JSONResponse({"error": "Too many requests, slow down."}, status_code=429)
    bundle = await get_bundle(slug)
    if bundle is None:
        return JSONResponse({"error": "app not found"}, status_code=404)
    if not bundle.backend_code:
        return JSONResponse({"error": "this app has no compute backend"}, status_code=404)
    try:
        payload = await request.json()
    except Exception:
        payload = {}
    raw_input = payload.get("input_data", payload) if isinstance(payload, dict) else {}
    input_data = raw_input if isinstance(raw_input, dict) else {}
    try:
        res = await run_backend(bundle.backend_code, input_data)
    except UnsafeCodeError:
        return JSONResponse({"error": "this app's backend can't run here"}, status_code=400)
    except Exception:
        return JSONResponse({"error": "compute failed"}, status_code=500)
    return JSONResponse({"result": res.result, "stdout": res.stdout})


@app.post("/__llm")
async def edge_llm(request: Request) -> Response:
    slug = slug_from_host(request.headers.get("host", ""))
    if not slug:
        return JSONResponse({"error": "unknown app"}, status_code=404)
    if not _llm_limiter.allow(client_ip(request)):
        return JSONResponse(
            {"type": "error", "error": {"type": "rate_limited", "message": "Too many requests."}},
            status_code=429,
        )
    body = await request.body()
    headers = {
        "x-edge-auth": EDGE_AUTH_TOKEN,
        "x-app-slug": slug,
        "content-type": "application/json",
    }
    for k in ("anthropic-version", "anthropic-beta"):
        v = request.headers.get(k)
        if v:
            headers[k] = v

    client = httpx.AsyncClient(timeout=httpx.Timeout(60.0, read=None))
    upstream_req = client.build_request("POST", f"{CLOUD_INTERNAL_URL}/api/apps/internal/llm", headers=headers, content=body)
    try:
        upstream = await client.send(upstream_req, stream=True)
    except httpx.HTTPError:
        await client.aclose()
        return JSONResponse(
            {"type": "error", "error": {"type": "upstream_unreachable", "message": "This app's AI is unavailable."}},
            status_code=502,
        )

    async def relay():
        try:
            async for chunk in upstream.aiter_raw():
                yield chunk
        finally:
            await upstream.aclose()
            await client.aclose()

    return StreamingResponse(
        relay(),
        status_code=upstream.status_code,
        media_type=upstream.headers.get("content-type", "application/json"),
    )


@app.get("/download/{platform}/{arch}")
async def edge_download(platform: str, arch: str, request: Request) -> Response:
    # This is an edge-app route, not an app-bundle route. Keeping the exact host
    # check prevents it from leaking onto every {slug}.openswarm.host domain.
    request_host = request.headers.get("host", "").split(":", 1)[0].lower()
    if request_host != EDGE_PUBLIC_HOST:
        return HTMLResponse(not_found_page(), status_code=404)
    if not _download_limiter.allow(client_ip(request)):
        return JSONResponse({"error": "Too many download requests, slow down."}, status_code=429)

    ref = (request.query_params.get("ref") or "").strip()
    authorize_body = {
        "platform": platform,
        "arch": arch,
        **({"ref": ref} if ref else {}),
    }
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            authorization = await client.post(
                f"{CLOUD_INTERNAL_URL}/api/install/authorize-download",
                headers={"x-edge-auth": EDGE_AUTH_TOKEN},
                json=authorize_body,
            )
    except httpx.HTTPError:
        return JSONResponse({"error": "Download authorization is unavailable."}, status_code=502)

    if authorization.status_code != 200:
        # Public validation errors are safe and useful to preserve. Internal
        # authentication/configuration failures are exposed only as a 502.
        if authorization.status_code in (400, 404, 429):
            try:
                detail = authorization.json()
                message = detail.get("message") or detail.get("error")
            except (ValueError, AttributeError):
                message = None
            return JSONResponse(
                {"error": message or "Download request was rejected."},
                status_code=authorization.status_code,
            )
        return JSONResponse({"error": "Download authorization failed."}, status_code=502)

    try:
        download = authorization.json()
    except ValueError:
        return JSONResponse({"error": "Download authorization returned invalid data."}, status_code=502)
    asset_url = download.get("assetUrl") if isinstance(download, dict) else None
    filename = download.get("filename") if isinstance(download, dict) else None
    if (
        not isinstance(asset_url, str)
        or not asset_url.startswith(("https://", "http://"))
        or not isinstance(filename, str)
        or not _DOWNLOAD_FILENAME_RE.fullmatch(filename)
    ):
        return JSONResponse({"error": "Download authorization returned invalid data."}, status_code=502)

    client = httpx.AsyncClient(timeout=httpx.Timeout(60.0, read=None), follow_redirects=True)
    upstream_req = client.build_request(
        "GET", asset_url, headers={"User-Agent": "openswarm-edge-download"}
    )
    try:
        upstream = await client.send(upstream_req, stream=True)
    except httpx.HTTPError:
        await client.aclose()
        return JSONResponse({"error": "Release artifact is unavailable."}, status_code=502)
    if not upstream.is_success:
        status = upstream.status_code
        await upstream.aclose()
        await client.aclose()
        return JSONResponse(
            {"error": f"Release artifact is unavailable ({status})."}, status_code=502
        )

    async def relay():
        try:
            async for chunk in upstream.aiter_raw():
                yield chunk
        finally:
            await upstream.aclose()
            await client.aclose()

    headers = {
        "Content-Disposition": f'attachment; filename="{filename}"',
        "Cache-Control": "private, no-store" if ref else "public, max-age=300",
    }
    content_length = upstream.headers.get("content-length")
    if content_length:
        headers["Content-Length"] = content_length

    return StreamingResponse(
        relay(),
        status_code=upstream.status_code,
        media_type=upstream.headers.get("content-type", "application/octet-stream"),
        headers=headers,
    )


@app.get("/{path:path}")
async def serve_static(path: str, request: Request) -> Response:
    slug = slug_from_host(request.headers.get("host", ""))
    if not slug:
        return HTMLResponse(apex_page(), status_code=404)
    bundle = await get_bundle(slug)
    if bundle is None:
        return HTMLResponse(not_found_page(), status_code=404)
    resolved = resolve_file(bundle, path)
    if resolved is None:
        return HTMLResponse(not_found_page(), status_code=404)
    data, mime = resolved
    if mime == "text/html":
        # Give the page the published-app runtime (OUTPUT_COMPUTE / OUTPUT_LLM).
        data = inject_runtime(data)
    return Response(content=data, media_type=mime, headers=_security_headers())
