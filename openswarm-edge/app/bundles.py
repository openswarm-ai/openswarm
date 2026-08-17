"""Fetch + cache published app bundles from Tigris (read-only key). A bundle is a
single apps/{slug}/bundle.tar.gz object; we unpack it once and cache the per-file
bytes keyed by slug with a short TTL so a republish shows up without a restart.
Every path lookup is guarded against traversal and never serves Python source."""
from __future__ import annotations

import asyncio
import io
import logging
import mimetypes
import os
import posixpath
import tarfile
import time
from dataclasses import dataclass
from typing import Optional

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

logger = logging.getLogger(__name__)

_ENDPOINT = os.environ.get("TIGRIS_ENDPOINT", "https://fly.storage.tigris.dev")
_BUCKET = os.environ.get("TIGRIS_BUCKET", "openswarm-app-bundles")
_TTL_SECONDS = int(os.environ.get("EDGE_BUNDLE_TTL_SECONDS", "120"))
# Misses are cached briefly too, so spraying random subdomains can't turn into one
# Tigris GET per request. Short enough that a fresh publish still shows up quickly.
_NEG_TTL_SECONDS = int(os.environ.get("EDGE_BUNDLE_NEG_TTL_SECONDS", "30"))
_MAX_CACHED_BUNDLES = int(os.environ.get("EDGE_BUNDLE_CACHE_MAX", "200"))
_MAX_NEG_CACHED = int(os.environ.get("EDGE_BUNDLE_NEG_CACHE_MAX", "5000"))
_MAX_UNPACKED_BYTES = 100 * 1024 * 1024  # guard against a decompression bomb

# Browsers are picky about these; mimetypes' OS table can disagree across distros.
_MIME_OVERRIDE = {
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".wasm": "application/wasm",
    ".map": "application/json",
}

_client = None


def _s3():
    global _client
    if _client is None:
        _client = boto3.client(
            "s3",
            endpoint_url=_ENDPOINT,
            region_name=os.environ.get("TIGRIS_REGION", "auto"),
            aws_access_key_id=os.environ.get("TIGRIS_ACCESS_KEY_ID", ""),
            aws_secret_access_key=os.environ.get("TIGRIS_SECRET_ACCESS_KEY", ""),
            config=Config(signature_version="s3v4"),
        )
    return _client


@dataclass
class Bundle:
    files: dict[str, bytes]
    backend_code: Optional[str]
    fetched_at: float


_cache: dict[str, Bundle] = {}
_negative: dict[str, float] = {}  # slug -> time of the miss, short TTL


def _bundle_key(slug: str) -> str:
    return f"apps/{slug}/bundle.tar.gz"


def _remember_miss(slug: str) -> None:
    if len(_negative) >= _MAX_NEG_CACHED:
        _negative.clear()
    _negative[slug] = time.time()


def unpack(tar_gz: bytes) -> Bundle:
    files: dict[str, bytes] = {}
    total = 0
    with tarfile.open(fileobj=io.BytesIO(tar_gz), mode="r:gz") as tar:
        for m in tar.getmembers():
            if not m.isfile():
                continue
            name = posixpath.normpath(m.name).lstrip("/")
            if name.startswith("..") or os.path.isabs(name):
                continue
            extracted = tar.extractfile(m)
            if extracted is None:
                continue
            data = extracted.read()
            total += len(data)
            if total > _MAX_UNPACKED_BYTES:
                raise ValueError("bundle exceeds the unpacked-size limit")
            files[name] = data
    backend = files.get("backend.py")
    backend_code = backend.decode("utf-8", errors="replace") if backend is not None else None
    return Bundle(files=files, backend_code=backend_code, fetched_at=time.time())


async def get_bundle(slug: str) -> Optional[Bundle]:
    cached = _cache.get(slug)
    if cached and time.time() - cached.fetched_at < _TTL_SECONDS:
        return cached
    missed_at = _negative.get(slug)
    if missed_at is not None and time.time() - missed_at < _NEG_TTL_SECONDS:
        return None
    try:
        obj = await asyncio.to_thread(lambda: _s3().get_object(Bucket=_BUCKET, Key=_bundle_key(slug)))
        raw = await asyncio.to_thread(obj["Body"].read)
    except ClientError as e:
        code = str(e.response.get("Error", {}).get("Code", ""))
        if code not in ("NoSuchKey", "404", "NoSuchBucket"):
            # creds/permission/other storage error: log it but still degrade to a
            # clean not-found rather than 500-ing every app on a storage hiccup.
            logger.warning("tigris get failed for %s: %s", slug, code or e)
        _cache.pop(slug, None)
        _remember_miss(slug)
        return None
    except Exception as e:
        # missing creds, network, malformed bundle: never 500 the whole edge.
        logger.warning("tigris get error for %s: %s", slug, e)
        _cache.pop(slug, None)
        _remember_miss(slug)
        return None
    try:
        bundle = unpack(raw)
    except Exception as e:
        logger.warning("bundle unpack failed for %s: %s", slug, e)
        _remember_miss(slug)
        return None
    if len(_cache) >= _MAX_CACHED_BUNDLES:
        oldest = min(_cache, key=lambda k: _cache[k].fetched_at)
        _cache.pop(oldest, None)
    _negative.pop(slug, None)
    _cache[slug] = bundle
    return bundle


_runtime_cache: dict[str, tuple[float, Optional[dict]]] = {}
_RUNTIME_TTL = 30.0


def _runtime_key(slug: str) -> str:
    return f"apps/{slug}/runtime.json"


async def get_runtime_spec(slug: str) -> Optional[dict]:
    """The app's runner-VM pointer, written by the cloud at publish (ENG-293). Lives NEXT TO the
    bundle, never inside it, so resolve_file can't serve it. Missing object = frontend-only app;
    cached briefly either way so per-request cost is one dict hit."""
    import asyncio, json as _json
    now = time.time()
    hit = _runtime_cache.get(slug)
    if hit and now - hit[0] < _RUNTIME_TTL:
        return hit[1]

    def _fetch() -> Optional[dict]:
        try:
            obj = _s3().get_object(Bucket=_BUCKET, Key=_runtime_key(slug))
            return _json.loads(obj["Body"].read())
        except Exception:
            return None

    spec = await asyncio.get_running_loop().run_in_executor(None, _fetch)
    if len(_runtime_cache) > 512:
        _runtime_cache.clear()
    _runtime_cache[slug] = (now, spec if isinstance(spec, dict) else None)
    return _runtime_cache[slug][1]


def resolve_file(bundle: Bundle, path: str) -> Optional[tuple[bytes, str]]:
    """Map a request path to a bundle file, SPA-falling back to index.html. Refuses
    traversal and Python source (served as index.html instead, never as code)."""
    rel = posixpath.normpath(path.lstrip("/"))
    if rel in ("", "."):
        rel = "index.html"
    if rel.startswith("..") or rel.endswith(".py"):
        rel = "index.html"
    data = bundle.files.get(rel)
    if data is None:
        data = bundle.files.get("index.html")
        rel = "index.html"
    if data is None:
        return None
    ext = posixpath.splitext(rel)[1].lower()
    mime = _MIME_OVERRIDE.get(ext) or mimetypes.guess_type(rel)[0] or "application/octet-stream"
    return data, mime
