"""Operational state forwarder.

Single public surface: `p_submit(kind, payload)`. The desktop hands off
opaque payload dicts; the cloud at api.openswarm.com is responsible for
parsing and routing them. The desktop has no schema knowledge.

Three `kind` values are accepted; they're the routing primitive the
cloud needs to send the payload to the right backend handler. The shape
of `payload` is opaque from the desktop's perspective; the cloud knows
how to read it.

  - "state":      lightweight periodic ping
  - "session":    full session dump on close
  - "diagnostic": error / bug-report context

Submissions that fail to deliver get spooled to a small SQLite file and
replayed on the next online tick. Bounded to 50 MB.
"""

from __future__ import annotations

import asyncio
import logging
import os
import platform
import time
from typing import Any, Optional
from uuid import uuid4

import httpx

from backend.apps.service import buffer
from backend.apps.service.version import APP_VERSION

logger = logging.getLogger(__name__)

P_DEFAULT_BASE = "https://api.openswarm.com"
P_PATH_BY_KIND = {
    "state": "/api/service/state",
    "session": "/api/service/sync",
    "diagnostic": "/api/service/diagnostics",
    "event": "/api/service/event",
}

P_TIMEOUT_SECONDS = 5.0
P_MAX_INFLIGHT = 16

P_TEST_SINK: Optional[Any] = None
P_INSTALL_ID: Optional[str] = None
P_USER_ID: Optional[str] = None
P_INFLIGHT: int = 0
P_INFLIGHT_LOCK = asyncio.Lock()
P_DRAIN_LOCK = asyncio.Lock()


# Public - Used by service.py
def spool_path() -> str:
    try:
        from backend.config.paths import SETTINGS_DIR
        return os.path.join(SETTINGS_DIR, "service_spool.db")
    except Exception:
        return os.path.expanduser("~/.openswarm/data/service_spool.db")


def p_get_install_id() -> str:
    global P_INSTALL_ID
    if P_INSTALL_ID:
        return P_INSTALL_ID
    try:
        from backend.apps.settings.store import load_settings, save_settings
        s = load_settings()
        iid = getattr(s, "installation_id", None)
        if not iid:
            iid = uuid4().hex
            s.installation_id = iid
            save_settings(s)
        P_INSTALL_ID = iid
    except Exception:
        P_INSTALL_ID = uuid4().hex
    return P_INSTALL_ID


def p_get_user_id() -> Optional[str]:
    global P_USER_ID
    if P_USER_ID:
        return P_USER_ID
    try:
        from backend.apps.settings.store import load_settings
        s = load_settings()
        # Prefer the cloud-issued user_id (UUID) if the user has signed in
        # via Google OAuth, magic link, or Stripe checkout; that's the
        # authoritative identity. Falls back to user_email for installs
        # that haven't completed sign-in yet (so existing onboarding-only
        # installs don't lose their Person history during the v1.0.29
        # rollout). After every install signs in, this fallback drops out.
        return (
            getattr(s, "user_id", None)
            or getattr(s, "user_email", None)
            or None
        )
    except Exception:
        return None



def p_is_enabled(kind: str) -> bool:
    """Honour user opt-out. Diagnostic always flows (errors block usability);
    state + session honour the toggle."""
    if kind == "diagnostic":
        return True
    try:
        from backend.apps.settings.store import load_settings
        s = load_settings()
        mode = getattr(s, "service_diagnostics_mode", None)
        if mode == "minimal":
            return False
        if mode is None:
            return bool(getattr(s, "analytics_opt_in", True))
        return True
    except Exception:
        return True


def resolve_timezone() -> Optional[str]:
    """Canonical IANA zone name for the envelope + app_lifecycle events.

    Identical in every build (dev, packaged, open-source). Precedence:
      1. Renderer-reported value persisted in settings — the browser Intl zone
         the frontend sends every launch.
      2. Python local-zone fallbacks (tzlocal, then datetime tzinfo), which can
         return abbreviations ("PDT") or localized names that don't round-trip
         through tzdata — last resort so very-early-startup submissions (before
         the renderer has reported) still carry something.
    """
    try:
        from backend.apps.settings.store import load_settings
        tz = (getattr(load_settings(), "timezone", None) or "").strip()
        if tz:
            return tz
    except Exception:
        pass
    try:
        from tzlocal import get_localzone_name  # type: ignore
        tz = get_localzone_name() or ""
        if tz:
            return tz
    except Exception:
        pass
    try:
        import datetime as dt
        local_tz = dt.datetime.now().astimezone().tzinfo
        if local_tz:
            return str(local_tz)
    except Exception:
        pass
    return None


def resolve_locale() -> Optional[str]:
    """BCP 47 locale ("en-US", "es-ES", ...) for the envelope + app_lifecycle
    events. Identical in every build: renderer-reported value persisted in
    settings -> None. No Python fallback: locale.getdefaultlocale() is
    deprecated, often empty, and inconsistent across OSes, so an absent value is
    better than a wrong one.
    """
    try:
        from backend.apps.settings.store import load_settings
        loc = (getattr(load_settings(), "locale", None) or "").strip()
        if loc:
            return loc
    except Exception:
        pass
    return None


def p_envelope() -> dict:
    """Identity + environment metadata stamped on every submission."""
    env: dict[str, Any] = {"install_id": p_get_install_id()}
    uid = p_get_user_id()
    if uid:
        env["user_id"] = uid
    try:
        env["os"] = platform.system()
        env["os_version"] = platform.release()
        env["device_type"] = "desktop"
    except Exception:
        pass
    tz = resolve_timezone()
    if tz:
        env["timezone"] = tz
    loc = resolve_locale()
    if loc:
        env["locale"] = loc
    env["app_version"] = APP_VERSION
    # How this build was packaged. Set by the platform-specific build script
    # (electron-builder afterPack hooks for dmg / exe / appimage / deb / rpm).
    # Defaults to "dev" when running from `bash run.sh` in a checked-out repo.
    env["install_method"] = os.environ.get("OPENSWARM_INSTALL_METHOD", "dev")
    return env


def p_base_url() -> str:
    try:
        from backend.apps.settings.store import load_settings
        from backend.apps.settings.credentials import OPENSWARM_DEFAULT_PROXY_URL
        s = load_settings()
        return (getattr(s, "openswarm_proxy_url", None) or OPENSWARM_DEFAULT_PROXY_URL).rstrip("/")
    except Exception:
        return P_DEFAULT_BASE


async def p_post(path: str, body: dict) -> int | None:
    url = f"{p_base_url()}{path}"
    try:
        async with httpx.AsyncClient(timeout=P_TIMEOUT_SECONDS) as c:
            r = await c.post(url, json=body)
        return r.status_code
    except Exception as e:
        logger.debug("service POST %s failed: %s", path, e)
        return None


def p_delivered(status: int | None) -> bool:
    return status is not None and 200 <= status < 300


# 429/timeouts/5xx/network are worth retrying; other 4xx means the payload itself is rejected and retrying forever would just poison the spool.
def p_retryable(status: int | None) -> bool:
    return status is None or status >= 500 or status in (408, 429)


async def p_post_or_spool(path: str, body: dict, kind: str) -> None:
    global P_INFLIGHT
    if P_TEST_SINK is not None:
        try:
            P_TEST_SINK(kind, body)
        except Exception as e:
            logger.debug("test sink raised: %s", e)
        return
    async with P_INFLIGHT_LOCK:
        if P_INFLIGHT >= P_MAX_INFLIGHT:
            buffer.enqueue(spool_path(), f"{kind}:{path}", body, now=time.time())
            return
        P_INFLIGHT += 1
    try:
        status = await p_post(path, body)
        if p_retryable(status):
            buffer.enqueue(spool_path(), f"{kind}:{path}", body, now=time.time())
        elif not p_delivered(status):
            logger.warning("service POST %s rejected with HTTP %s; payload dropped", path, status)
    finally:
        async with P_INFLIGHT_LOCK:
            P_INFLIGHT = max(0, P_INFLIGHT - 1)


# Public - Used by service.py
async def drain_spool(batch_size: int = 50) -> int:
    async with P_DRAIN_LOCK:
        entries = buffer.drain(spool_path(), batch_size=batch_size)
        if not entries:
            return 0
        succeeded: list[int] = []
        for rid, kind_path, body in entries:
            kind, _, path = kind_path.partition(":")
            if not path:
                succeeded.append(rid)
                continue
            status = await p_post(path, body)
            if p_delivered(status):
                succeeded.append(rid)
            elif p_retryable(status):
                break
            else:
                logger.warning("service replay %s rejected with HTTP %s; dropping spooled row", path, status)
                succeeded.append(rid)
        if succeeded:
            buffer.acknowledge(spool_path(), succeeded)
        return len(succeeded)


# --------------------------------------------------------------------------
# Public API
# --------------------------------------------------------------------------

def p_log(kind: str) -> None:
    """Append to the rolling operational log for diagnostics."""
    try:
        from backend.apps.service.ring_buffer import record as ring_record
        ring_record(kind)
    except Exception:
        pass


# Public - Used by agents.py, settings.py, cloud_sync.py, subscription.router.py, service.py
def sync(data: dict | None = None) -> None:
    """Sync operational state to the cloud. Single entry point.

    Accepts any dict; the cloud determines what it is from the shape.
    The desktop has no knowledge of event types, schemas, or routing.

    Each call carries:
      - `t`: client-side timestamp at submit time (unix seconds, float).
      - `submission_id`: uuid generated per call. The cloud uses
        (install_id, submission_id) as an idempotency key, so a retry
        from the offline spool is a no-op rather than a double-write.

    Fire-and-forget; never raises.
    """
    payload = data or {}
    if not p_is_enabled("state"):
        return
    body = {
        "client_state": p_envelope(),
        "d": payload,
        "t": time.time(),
        "submission_id": uuid4().hex,
    }
    p_log("s")
    if P_TEST_SINK is not None:
        try:
            P_TEST_SINK("s", body)
        except Exception as e:
            logger.debug("test sink raised: %s", e)
        return
    p_schedule(p_post_or_spool(P_DEFAULT_SYNC_PATH, body, "s"))


# Internal routing; the cloud has one endpoint for everything.
P_DEFAULT_SYNC_PATH = "/api/service/sync"


def p_submit(payload: dict) -> None:
    """Routes through sync(). The cloud demuxes by payload shape (state /
    sync / diagnostic / event), so kind here is informational; the routing
    happens server-side in openswarm-cloud/src/routes/service/ingest.ts.
    New call sites should use sync() directly with a well-shaped payload."""
    sync(payload)


def p_schedule(coro) -> None:
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None
    if loop is not None:
        loop.create_task(coro)
        return
    import threading

    def run_coro():
        try:
            asyncio.run(coro)
        except Exception:
            pass

    threading.Thread(target=run_coro, daemon=True).start()


# --------------------------------------------------------------------------
# Backwards-compat shims for legacy call sites. New code calls p_submit(()
# directly. These keep the ~50 existing import sites in the codebase
# working unchanged. Removed in a future cleanup once nothing imports
# from older import paths.
# --------------------------------------------------------------------------

# Public - Used by agent_manager.py
def submit_diagnostic(diagnostic: dict) -> None:
    try:
        from backend.apps.service.ring_buffer import snapshot
        diagnostic["recent_log"] = snapshot()
    except Exception:
        pass
    p_submit("diagnostic", {"diagnostic": diagnostic})


# Public - Used by settings.py, auth.router.py, subscription.router.py
def identify(extra_properties: Optional[dict] = None) -> None:
    p_submit("state", {"identity": extra_properties or {}})
