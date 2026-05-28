"""Operational state forwarder.

Single public surface: `submit(kind, payload)`. The desktop hands off
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

_DEFAULT_BASE = "https://api.openswarm.com"
_PATH_BY_KIND = {
    "state": "/api/service/state",
    "session": "/api/service/sync",
    "diagnostic": "/api/service/diagnostics",
    "event": "/api/service/event",
}

_TIMEOUT_SECONDS = 5.0
_MAX_INFLIGHT = 16

_test_sink: Optional[Any] = None
_install_id: Optional[str] = None
_user_id: Optional[str] = None
_inflight = 0
_inflight_lock = asyncio.Lock()
_drain_lock = asyncio.Lock()


def _spool_path() -> str:
    try:
        from backend.config.paths import SETTINGS_DIR
        return os.path.join(SETTINGS_DIR, "service_spool.db")
    except Exception:
        return os.path.expanduser("~/.openswarm/data/service_spool.db")


def set_test_sink(fn: Optional[Any]) -> None:
    """Test seam; receives every submission instead of the network."""
    global _test_sink
    _test_sink = fn


def _get_install_id() -> str:
    global _install_id
    if _install_id:
        return _install_id
    try:
        from backend.apps.settings.store import load_settings, _save_settings
        s = load_settings()
        iid = getattr(s, "installation_id", None)
        if not iid:
            iid = uuid4().hex
            s.installation_id = iid
            _save_settings(s)
        _install_id = iid
    except Exception:
        _install_id = uuid4().hex
    return _install_id


def _get_user_id() -> Optional[str]:
    global _user_id
    if _user_id:
        return _user_id
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


def set_user_id(uid: Optional[str]) -> None:
    global _user_id
    _user_id = uid or None


def _is_enabled(kind: str) -> bool:
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


def _envelope() -> dict:
    """Identity + environment metadata stamped on every submission."""
    env: dict[str, Any] = {"install_id": _get_install_id()}
    uid = _get_user_id()
    if uid:
        env["user_id"] = uid
    try:
        env["os"] = platform.system()
        env["os_version"] = platform.release()
        env["device_type"] = "desktop"
    except Exception:
        pass
    # Timezone: prefer the IANA zone name passed in by Electron (always
    # canonical, e.g. "America/Los_Angeles") so cloud-side localTimeFields()
    # can format hour-of-day correctly. Fall back to Python's local zone
    # which sometimes returns abbreviations (PDT, CDT) or localized names
    # ("Romance (zomertijd)") that don't round-trip through tzdata.
    try:
        ianatz = os.environ.get("OPENSWARM_TIMEZONE", "").strip()
        if not ianatz:
            try:
                from tzlocal import get_localzone_name  # type: ignore
                ianatz = get_localzone_name() or ""
            except Exception:
                pass
        if not ianatz:
            import datetime as _dt
            local_tz = _dt.datetime.now().astimezone().tzinfo
            if local_tz:
                ianatz = str(local_tz)
        if ianatz:
            env["timezone"] = ianatz
    except Exception:
        pass
    # Locale: BCP 47 string ("en-US", "es-ES", etc.) injected by Electron via
    # app.getLocale(); see electron/main.js. We don't fall back to Python's
    # locale.getdefaultlocale() because that's deprecated, often empty, and
    # returns inconsistent OS-specific values across macOS/Windows/Linux.
    try:
        loc = os.environ.get("OPENSWARM_LOCALE", "").strip()
        if loc:
            env["locale"] = loc
    except Exception:
        pass
    env["app_version"] = APP_VERSION
    # How this build was packaged. Set by the platform-specific build script
    # (electron-builder afterPack hooks for dmg / exe / appimage / deb / rpm).
    # Defaults to "dev" when running from `bash run.sh` in a checked-out repo.
    env["install_method"] = os.environ.get("OPENSWARM_INSTALL_METHOD", "dev")
    return env


def _base_url() -> str:
    try:
        from backend.apps.settings.store import load_settings
        from backend.apps.settings.credentials import OPENSWARM_DEFAULT_PROXY_URL
        s = load_settings()
        return (getattr(s, "openswarm_proxy_url", None) or OPENSWARM_DEFAULT_PROXY_URL).rstrip("/")
    except Exception:
        return _DEFAULT_BASE


async def _post(path: str, body: dict) -> bool:
    url = f"{_base_url()}{path}"
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT_SECONDS) as c:
            r = await c.post(url, json=body)
        return 200 <= r.status_code < 500
    except Exception as e:
        logger.debug("service POST %s failed: %s", path, e)
        return False


async def _post_or_spool(path: str, body: dict, kind: str) -> None:
    global _inflight
    if _test_sink is not None:
        try:
            _test_sink(kind, body)
        except Exception as e:
            logger.debug("test sink raised: %s", e)
        return
    async with _inflight_lock:
        if _inflight >= _MAX_INFLIGHT:
            buffer.enqueue(_spool_path(), f"{kind}:{path}", body, now=time.time())
            return
        _inflight += 1
    try:
        ok = await _post(path, body)
        if not ok:
            buffer.enqueue(_spool_path(), f"{kind}:{path}", body, now=time.time())
    finally:
        async with _inflight_lock:
            _inflight = max(0, _inflight - 1)


async def drain_spool(batch_size: int = 50) -> int:
    async with _drain_lock:
        entries = buffer.drain(_spool_path(), batch_size=batch_size)
        if not entries:
            return 0
        succeeded: list[int] = []
        for rid, kind_path, body in entries:
            kind, _, path = kind_path.partition(":")
            if not path:
                succeeded.append(rid)
                continue
            ok = await _post(path, body)
            if ok:
                succeeded.append(rid)
            else:
                break
        if succeeded:
            buffer.acknowledge(_spool_path(), succeeded)
        return len(succeeded)


# --------------------------------------------------------------------------
# Public API
# --------------------------------------------------------------------------

def _log(kind: str, payload: dict) -> None:
    """Append to the rolling operational log for diagnostics."""
    try:
        from backend.apps.service.ring_buffer import record
        record(kind)
    except Exception:
        pass


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
    if not _is_enabled("state"):
        return
    body = {
        "client_state": _envelope(),
        "d": payload,
        "t": time.time(),
        "submission_id": uuid4().hex,
    }
    _log("s", payload)
    if _test_sink is not None:
        try:
            _test_sink("s", body)
        except Exception as e:
            logger.debug("test sink raised: %s", e)
        return
    _schedule(_post_or_spool(_DEFAULT_SYNC_PATH, body, "s"))


# Internal routing; the cloud has one endpoint for everything.
_DEFAULT_SYNC_PATH = "/api/service/sync"


def submit(kind: str, payload: dict) -> None:
    """Routes through sync(). The cloud demuxes by payload shape (state /
    sync / diagnostic / event), so kind here is informational; the routing
    happens server-side in openswarm-cloud/src/routes/service/ingest.ts.
    New call sites should use sync() directly with a well-shaped payload."""
    sync(payload)


def _schedule(coro) -> None:
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None
    if loop is not None:
        loop.create_task(coro)
        return
    import threading

    def _run():
        try:
            asyncio.run(coro)
        except Exception:
            pass

    threading.Thread(target=_run, daemon=True).start()


# --------------------------------------------------------------------------
# Backwards-compat shims for legacy call sites. New code calls submit()
# directly. These keep the ~50 existing import sites in the codebase
# working unchanged. Removed in a future cleanup once nothing imports
# from older import paths.
# --------------------------------------------------------------------------

def submit_event(
    surface: str,
    action: str,
    props: Optional[dict] = None,
    *,
    session_id: Optional[str] = None,
    dashboard_id: Optional[str] = None,
    kind: str = "event",
) -> None:
    """Legacy event-shape submit. Bundles surface/action into the opaque
    payload and hands off via submit()."""
    p = {
        "surface": surface,
        "action": action,
        "props": props or {},
        "session_id": session_id,
        "dashboard_id": dashboard_id,
    }
    submit("event", p)


def submit_state(*, sessions_open: int = 0, connectors_active: int = 0) -> None:
    submit("state", {"sessions_open": sessions_open, "connectors_active": connectors_active})


def submit_session_close(session_dump: dict, activity: Optional[dict] = None) -> None:
    submit("session", {"usage_window": session_dump, "activity": activity or {}})


def submit_diagnostic(diagnostic: dict) -> None:
    try:
        from backend.apps.service.ring_buffer import snapshot
        diagnostic["recent_log"] = snapshot()
    except Exception:
        pass
    submit("diagnostic", {"diagnostic": diagnostic})


def update_identity(extra: Optional[dict] = None) -> None:
    submit("state", {"identity": extra or {}})


def record(
    event_type: str,
    properties: Optional[dict] = None,
    session_id: Optional[str] = None,
    dashboard_id: Optional[str] = None,
) -> None:
    """Legacy collector.record() shim; splits dotted name into surface/action."""
    if "." in event_type:
        surface, action = event_type.split(".", 1)
    else:
        surface, action = event_type, "fired"
    submit_event(
        surface=surface, action=action, props=properties or {},
        session_id=session_id, dashboard_id=dashboard_id,
    )


def identify(extra_properties: Optional[dict] = None) -> None:
    update_identity(extra_properties or {})
