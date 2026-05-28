import asyncio
import os
import tempfile
import time
import logging
from contextlib import asynccontextmanager
from fastapi import HTTPException, Query, UploadFile, File
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from typing import Literal, Optional

from backend.config.Apps import SubApp
from backend.apps.settings.models import AppSettings, DEFAULT_SYSTEM_PROMPT
from backend.apps.settings.store import (
    DATA_DIR,
    SETTINGS_FILE,
    load_settings,
    save_settings,
    _save_settings,
    _atomic_write_settings,
    _migrate_legacy_fields,
)

logger = logging.getLogger(__name__)


@asynccontextmanager
async def settings_lifespan():
    os.makedirs(DATA_DIR, exist_ok=True)
    try:
        from backend.apps.nine_router import (
            ensure_running as _9r_ensure,
            sync_gemini_api_key,
            sync_openai_api_key,
            sync_openrouter_api_key,
            sync_openswarm_pro_as_claude,
            sync_custom_providers,
        )
        s = load_settings()
        import asyncio as _asyncio

        async def _boot_router_then_sync():
            """Boot 9Router then push key-based connections (sequential: sync helpers no-op pre-boot)."""
            needs_router = any([
                getattr(s, "google_api_key", None),
                getattr(s, "openai_api_key", None),
                getattr(s, "openrouter_api_key", None),
                getattr(s, "connection_mode", None) == "openswarm-pro",
                bool(getattr(s, "custom_providers", None) or []),
            ])
            if needs_router:
                try:
                    await _9r_ensure()
                except Exception as e:
                    logger.warning(f"9Router lifespan boot failed: {e}")
            if getattr(s, "google_api_key", None):
                await sync_gemini_api_key(s.google_api_key)
            if getattr(s, "openai_api_key", None):
                await sync_openai_api_key(s.openai_api_key)
            if getattr(s, "openrouter_api_key", None):
                await sync_openrouter_api_key(s.openrouter_api_key)
            if getattr(s, "connection_mode", None) == "openswarm-pro":
                bearer = getattr(s, "openswarm_bearer_token", None)
                proxy = getattr(s, "openswarm_proxy_url", None) or "https://api.openswarm.com"
                if bearer:
                    await sync_openswarm_pro_as_claude(bearer, proxy)
            await sync_custom_providers(getattr(s, "custom_providers", None) or [])

        _asyncio.create_task(_boot_router_then_sync())
        _asyncio.create_task(_upload_dir_gc_loop())
    except Exception as e:
        logger.warning(f"9Router sync startup failed: {e}")
    yield


async def _upload_dir_gc_loop():
    """Daily GC of UPLOAD_DIR. Without this, every PDF/image the user
    drops sits in the OS temp dir forever, growing unbounded across
    sessions. We keep files for 7 days to make resume-after-restart
    work, then delete. macOS temp under /var/folders/... is auto-purged
    by the OS but not aggressively; Windows temp is not. Belt and braces.
    Errors are swallowed: a chmod hiccup or in-use lock should never
    crash the backend."""
    import asyncio as _a
    while True:
        try:
            now = time.time()
            cutoff = now - 7 * 86400
            if os.path.isdir(UPLOAD_DIR):
                for entry in os.listdir(UPLOAD_DIR):
                    p = os.path.join(UPLOAD_DIR, entry)
                    try:
                        if os.path.isfile(p) and os.path.getmtime(p) < cutoff:
                            os.remove(p)
                    except Exception:
                        continue
        except Exception:
            pass
        await _a.sleep(24 * 3600)


settings = SubApp("settings", settings_lifespan)


async def save_settings_async(settings_obj: AppSettings) -> None:
    """Async atomic save via thread pool; shares the lock with the sync variant."""
    payload = settings_obj.model_dump()
    loop = asyncio.get_running_loop()
    await loop.run_in_executor(None, _atomic_write_settings, payload)


@settings.router.get("")
async def get_settings():
    return load_settings().model_dump()


@settings.router.get("/install-id")
async def get_install_id_public():
    """Return a stable per-install identifier for OAuth start flows.

    This route intentionally returns only `install_id` so browser-only dev
    runs (no Electron preload token) can still initiate Google/email sign-in
    without exposing the full settings payload.
    """
    from backend.config.install_id import get_install_id

    return {"install_id": get_install_id()}


@settings.router.put("")
async def update_settings(body: AppSettings):
    from backend.apps.service.client import sync as _sync

    old = load_settings()

    secret_keys = {"anthropic_api_key", "openai_api_key", "google_api_key", "openrouter_api_key",
                   "claude_subscription_token", "openai_subscription_token", "gemini_subscription_token",
                   "openswarm_bearer_token", "installation_id"}
    safe = {k: v for k, v in body.model_dump().items() if k not in secret_keys}
    _sync(safe)

    if (body.user_email and body.user_email != getattr(old, "user_email", None)) or \
       (body.user_name and body.user_name != getattr(old, "user_name", None)):
        from backend.apps.service.client import identify as _identify
        id_props = {}
        if body.user_email:
            id_props["email"] = body.user_email
        if body.user_name:
            id_props["name"] = body.user_name
        if body.user_use_case:
            id_props["use_case"] = body.user_use_case
        if body.user_referral_source:
            id_props["referral_source"] = body.user_referral_source
        if id_props:
            _identify(id_props)

    await save_settings_async(body)

    google_changed = (
        getattr(body, "google_api_key", None) != getattr(old, "google_api_key", None)
    )
    openai_changed = (
        getattr(body, "openai_api_key", None) != getattr(old, "openai_api_key", None)
    )
    openrouter_changed = (
        getattr(body, "openrouter_api_key", None) != getattr(old, "openrouter_api_key", None)
    )
    custom_providers_changed = (
        [cp.model_dump() for cp in (getattr(body, "custom_providers", None) or [])]
        != [cp.model_dump() for cp in (getattr(old, "custom_providers", None) or [])]
    )
    any_keyed_added = (
        (getattr(body, "google_api_key", None) and not getattr(old, "google_api_key", None))
        or (getattr(body, "openai_api_key", None) and not getattr(old, "openai_api_key", None))
        or (getattr(body, "openrouter_api_key", None) and not getattr(old, "openrouter_api_key", None))
        or (
            bool(getattr(body, "custom_providers", None) or [])
            and not bool(getattr(old, "custom_providers", None) or [])
        )
    )

    if openrouter_changed:
        try:
            from backend.apps.agents.providers.registry import invalidate_openrouter_cache
            invalidate_openrouter_cache()
        except Exception:
            pass

    # Off the request path: ensure_running() can take 5min on first install (npm pull) and would freeze the loop.
    if google_changed or openai_changed or openrouter_changed or custom_providers_changed:
        async def _boot_and_sync_keys(
            google_key: str | None,
            openai_key: str | None,
            openrouter_key: str | None,
            custom_providers: list,
            do_google: bool,
            do_openai: bool,
            do_openrouter: bool,
            do_custom: bool,
            need_boot: bool,
        ):
            try:
                from backend.apps.nine_router import (
                    ensure_running as _9r_ensure,
                    is_running as _9r_running,
                    sync_gemini_api_key,
                    sync_openai_api_key,
                    sync_openrouter_api_key,
                    sync_custom_providers,
                )
                if need_boot and not _9r_running():
                    await _9r_ensure()
                if do_google:
                    await sync_gemini_api_key(google_key or None)
                if do_openai:
                    await sync_openai_api_key(openai_key or None)
                if do_openrouter:
                    await sync_openrouter_api_key(openrouter_key or None)
                if do_custom:
                    await sync_custom_providers(custom_providers or [])
            except Exception as e:
                logger.warning(f"Background apikey sync failed: {e}")

        asyncio.create_task(_boot_and_sync_keys(
            getattr(body, "google_api_key", None),
            getattr(body, "openai_api_key", None),
            getattr(body, "openrouter_api_key", None),
            getattr(body, "custom_providers", None) or [],
            google_changed,
            openai_changed,
            openrouter_changed,
            custom_providers_changed,
            any_keyed_added,
        ))

    # On pro-mode/bearer change, register a `claude` apikey connection in 9Router so CLI WebSearch works on non-Claude primaries.
    pro_mode_old = getattr(old, "connection_mode", None) == "openswarm-pro"
    pro_mode_new = getattr(body, "connection_mode", None) == "openswarm-pro"
    bearer_old = getattr(old, "openswarm_bearer_token", None)
    bearer_new = getattr(body, "openswarm_bearer_token", None)
    if pro_mode_old != pro_mode_new or bearer_old != bearer_new:
        try:
            from backend.apps.nine_router import sync_openswarm_pro_as_claude
            proxy_url = getattr(body, "openswarm_proxy_url", None) or "https://api.openswarm.com"
            await sync_openswarm_pro_as_claude(
                bearer_new if pro_mode_new else None,
                proxy_url if pro_mode_new else None,
            )
        except Exception as e:
            logger.warning(f"OpenSwarm-Pro → Claude sync failed: {e}")

    return {"ok": True, "settings": body.model_dump()}


class AppThemeOverridePayload(BaseModel):
    mode: Optional[Literal["light", "dark"]] = None


@settings.router.get("/app-theme-override")
async def get_app_theme_override():
    """Cross-app theme preference for App Builder workspaces; backend-held because each app uses its own localStorage origin."""
    return {"mode": load_settings().app_template_theme_override}


@settings.router.put("/app-theme-override")
async def put_app_theme_override(body: AppThemeOverridePayload):
    """MERGE the override; the general PUT /api/settings replaces the whole object and would blank secrets, logging the user out."""
    current = load_settings()
    current.app_template_theme_override = body.mode
    await save_settings_async(current)
    return {"ok": True, "mode": current.app_template_theme_override}


@settings.router.get("/default-system-prompt")
async def get_default_system_prompt():
    return {"default_system_prompt": DEFAULT_SYSTEM_PROMPT}


@settings.router.post("/reset-system-prompt")
async def reset_system_prompt():
    current = load_settings()
    current.default_system_prompt = DEFAULT_SYSTEM_PROMPT
    await save_settings_async(current)
    return {"ok": True, "settings": current.model_dump()}


class BrowseResponse(BaseModel):
    current: str
    parent: Optional[str]
    directories: list[str]
    files: list[str]


UPLOAD_DIR = os.path.join(tempfile.gettempdir(), "self-swarm-uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)


def _sniff_file_kind(contents: bytes, name: str) -> tuple[str, str | None]:
    """Classify an uploaded file as text/pdf/image/binary so the agent
    layer can route it (inline as text, send as native document/image
    block, or refuse). Returns (kind, media_type)."""
    head = contents[:4096]
    if head.startswith(b"%PDF-"):
        return ("pdf", "application/pdf")
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return ("image", "image/png")
    if head.startswith(b"\xff\xd8\xff"):
        return ("image", "image/jpeg")
    if head.startswith(b"GIF87a") or head.startswith(b"GIF89a"):
        return ("image", "image/gif")
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return ("image", "image/webp")
    # Other common binary signatures that don't contain a null byte in the
    # first few bytes (so the null-byte fallback below would miss them):
    # zip/docx/xlsx/pptx/jar/apk/odt (PK\x03\x04), gzip (\x1f\x8b),
    # 7z (7z\xbc\xaf), tar (ustar magic at offset 257), rar (Rar!\x1a\x07),
    # ELF (\x7fELF), Mach-O (\xfe\xed\xfa\xce / \xce\xfa\xed\xfe), Win exe
    # (MZ), Java class (\xca\xfe\xba\xbe), sqlite (SQLite format 3\x00).
    if (head.startswith(b"PK\x03\x04") or head.startswith(b"PK\x05\x06") or
        head.startswith(b"\x1f\x8b") or head.startswith(b"7z\xbc\xaf\x27\x1c") or
        head.startswith(b"Rar!\x1a\x07") or head.startswith(b"\x7fELF") or
        head.startswith(b"\xfe\xed\xfa\xce") or head.startswith(b"\xce\xfa\xed\xfe") or
        head.startswith(b"\xfe\xed\xfa\xcf") or head.startswith(b"\xcf\xfa\xed\xfe") or
        head.startswith(b"MZ") or head.startswith(b"\xca\xfe\xba\xbe") or
        head.startswith(b"SQLite format 3\x00")):
        return ("binary", None)
    # Binary heuristic: any null bytes in the first 4KB is a strong "not text" signal.
    # Falls back gracefully for unusual encodings (UTF-16 has nulls too, but we treat
    # those as binary for safety since the agent's `open(..., "r")` would misread them).
    if b"\x00" in head:
        return ("binary", None)
    try:
        head.decode("utf-8")
        return ("text", "text/plain")
    except UnicodeDecodeError:
        return ("binary", None)


def _estimate_pdf_tokens(contents: bytes) -> int:
    """Conservative PDF token estimate without a parser dep.

    We use two signals and take the MAX so the chip + dry-run never
    under-report:

      1) Page count from the PDF catalog (regex over /Type /Pages /Count
         then a fallback for /Count just before /Kids). When found, we
         estimate 750 tokens/page, a fair midpoint between dense academic
         papers (~1200) and sparse decks (~300).
      2) Byte-size heuristic. PDFs compress text and embed images; the
         actual token cost on Anthropic's vision tier scales with file
         size. ~1 token per 80 bytes is conservative.

    Taking max() means a small page count on a huge PDF (image-heavy)
    still reads as expensive, and a huge page count on a small PDF still
    reads as expensive. The chip never lies that an attachment is cheap."""
    import re as _re
    by_pages = 0
    try:
        # Prefer the root catalog's /Pages entry. PDFs can have nested
        # /Count fields (outlines, sub-pages), so anchor on /Type /Pages.
        m = _re.search(rb"/Type\s*/Pages\b[^>]{0,200}?/Count\s+(\d+)", contents, _re.DOTALL)
        if not m:
            # Fallback: catalog declares /Pages then references /Count via /Kids.
            m = _re.search(rb"/Pages[^>]{0,200}?/Count\s+(\d+)", contents, _re.DOTALL)
        if m:
            pages = int(m.group(1))
            if 0 < pages < 10_000:
                by_pages = pages * 750
    except Exception:
        pass
    by_bytes = max(1_000, min(len(contents) // 80, 2_000_000))
    return max(by_pages, by_bytes)


@settings.router.post("/upload-files")
async def upload_files(files: list[UploadFile] = File(...)):
    """Accept dropped files, sniff their kind, save them, and return
    server-side paths + a `kind` + `tokens` estimate per file.

    The chat UI uses `tokens` for the per-chip chip count and the pre-send
    dry-run guard; it uses `kind` to decide whether the file routes as
    inline text, a native document block (PDF on Anthropic/Gemini), an
    image block (vision-capable models), or gets refused (other binary,
    until we add Files API support).

    Estimates per kind:
      - text: char/4 of the actually-readable text (capped at 512KB)
      - pdf:  page-count * 750 (conservative; real text-heavy PDFs run
              ~500-1200 tokens/page)
      - image: 1500 (Anthropic's per-image baseline; varies by size)
      - binary: 0 (refused at agent time, won't enter context)
    """
    results = []
    for f in files:
        safe_name = os.path.basename(f.filename or "untitled")
        # Strip path separators that survived basename on Windows-typed
        # uploads where filename arrived with backslashes preserved.
        safe_name = safe_name.replace("\\", "_").replace("/", "_") or "untitled"
        contents = await f.read()

        # Atomic create-with-collision-retry so two concurrent uploads with
        # the same filename never overwrite each other. The previous
        # exists() then open() pattern had a race window: both callers
        # would observe `dest` free and both would write, with the second
        # winning. O_EXCL fails the create if anyone else got there first.
        base, ext = os.path.splitext(safe_name)
        dest = os.path.join(UPLOAD_DIR, safe_name)
        counter = 0
        fd = None
        while fd is None:
            try:
                fd = os.open(dest, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
            except FileExistsError:
                counter += 1
                if counter > 10_000:
                    raise HTTPException(status_code=500, detail="upload dedup exhausted")
                dest = os.path.join(UPLOAD_DIR, f"{base}_{counter}{ext}")
        try:
            with os.fdopen(fd, "wb") as fh:
                fh.write(contents)
        except Exception:
            try:
                os.remove(dest)
            except Exception:
                pass
            raise

        kind, media_type = _sniff_file_kind(contents, safe_name)

        if kind == "text":
            try:
                with open(dest, "r", errors="replace") as fh:
                    txt = fh.read(512_000)
                tokens_est = max(0, len(txt) // 4)
            except Exception:
                tokens_est = min(len(contents), 512_000) // 4
        elif kind == "pdf":
            tokens_est = _estimate_pdf_tokens(contents)
        elif kind == "image":
            tokens_est = 1_500
        else:
            tokens_est = 0

        results.append({
            "path": dest,
            "name": safe_name,
            "size": len(contents),
            "tokens": tokens_est,
            "kind": kind,
            "media_type": media_type,
        })

    return JSONResponse({"files": results})


class _SummarizeRequest(BaseModel):
    path: str
    target_tokens: int = 4_000
    primary_model: Optional[str] = None


@settings.router.post("/summarize-file")
async def summarize_file(req: _SummarizeRequest):
    """Compress an attached file down to a fact-dense summary the agent can
    still reason over without paying the full token cost.

    Called from the chat-input attach handler when one file alone would
    exceed 50% of the selected model's context window. The summary is
    written to a sibling file with `.summary.txt` suffix in UPLOAD_DIR so
    the existing attachment plumbing (paths flow through context_paths)
    works unchanged. Aux model picked via provider-agnostic
    resolve_aux_model, so users on OpenAI/Gemini/OpenRouter get summarized
    via their own provider's cheap tier (never hardcoded to Haiku).
    """
    src = req.path
    if not os.path.isfile(src):
        raise HTTPException(status_code=404, detail="file not found")
    if not os.path.commonpath([os.path.realpath(src), os.path.realpath(UPLOAD_DIR)]) == os.path.realpath(UPLOAD_DIR):
        raise HTTPException(status_code=400, detail="path outside upload dir")

    try:
        with open(src, "r", errors="replace") as fh:
            raw = fh.read(2_000_000)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"read failed: {e}")

    if (len(raw) // 4) <= max(1, req.target_tokens):
        return JSONResponse({"path": src, "tokens": len(raw) // 4, "size": len(raw), "summarized": False})

    try:
        from backend.apps.agents.providers.registry import resolve_aux_model, get_api_type
        from backend.apps.settings.credentials import get_anthropic_client_for_model
        s = load_settings()
        aux_model, _base = await resolve_aux_model(
            s,
            preferred_tier="haiku",
            primary_api=get_api_type(req.primary_model) if req.primary_model else None,
        )
        client = get_anthropic_client_for_model(s, aux_model)
        system = (
            "You compress a document into a fact-dense summary while preserving every "
            "specific entity, number, date, quote, code identifier, and decision. Use "
            "short bullets grouped by section. Never invent. If a section is unclear, "
            "say so. Aim for roughly the target token budget."
        )
        user = (
            f"Target length: ~{req.target_tokens} tokens.\n\n"
            f"<document path=\"{os.path.basename(src)}\">\n{raw}\n</document>\n\n"
            "Summary:"
        )
        resp = await client.messages.create(
            model=aux_model,
            max_tokens=min(8_192, max(512, req.target_tokens + 1_024)),
            system=system,
            messages=[{"role": "user", "content": user}],
        )
        summary = ""
        try:
            for b in (getattr(resp, "content", None) or []):
                t = getattr(b, "text", None)
                if isinstance(t, str) and t:
                    summary += t
        except Exception:
            summary = ""
        if not summary.strip():
            raise RuntimeError("empty summary from aux model")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"summarize failed: {e}")

    base, _ext = os.path.splitext(src)
    dest = f"{base}.summary.txt"
    counter = 1
    while os.path.exists(dest):
        dest = f"{base}.summary_{counter}.txt"
        counter += 1
    body = (
        f"Summary of {os.path.basename(src)} "
        f"(compressed from ~{len(raw) // 4} tokens to ~{len(summary) // 4} tokens)\n\n"
        f"{summary}\n"
    )
    with open(dest, "w") as fh:
        fh.write(body)
    return JSONResponse({
        "path": dest,
        "tokens": len(body) // 4,
        "size": len(body),
        "summarized": True,
    })


@settings.router.get("/browse-directories")
async def browse_directories(path: str = Query(default="")) -> BrowseResponse:
    target = path.strip() if path.strip() else os.path.expanduser("~")
    target = os.path.expanduser(target)
    target = os.path.abspath(target)

    if not os.path.exists(target):
        raise HTTPException(status_code=404, detail=f"Path not found: {target}")
    if not os.path.isdir(target):
        raise HTTPException(status_code=400, detail=f"Not a directory: {target}")

    try:
        entries = sorted(os.listdir(target))
    except PermissionError:
        raise HTTPException(status_code=403, detail=f"Permission denied: {target}")

    visible = [e for e in entries if not e.startswith(".")]
    directories = [e for e in visible if os.path.isdir(os.path.join(target, e))]
    files = [e for e in visible if os.path.isfile(os.path.join(target, e))]

    parent = os.path.dirname(target) if target != "/" else None

    return BrowseResponse(current=target, parent=parent, directories=directories, files=files)
