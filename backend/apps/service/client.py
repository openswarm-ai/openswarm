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
from backend.apps.service.settings_gateway import DEFAULT_SETTINGS_GATEWAY, SettingsGateway
from backend.apps.service.version import APP_VERSION
from backend.apps.settings.redaction import redact_settings

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


def resolve_timezone(gateway: SettingsGateway = DEFAULT_SETTINGS_GATEWAY) -> str:
    """Settings-first (the only source that works on dev / OSS), then OS, then UTC."""
    try:
        tz = getattr(gateway.load(), "timezone", None)
        if tz:
            return tz
    except Exception:
        pass
    try:
        from tzlocal import get_localzone_name
        name = get_localzone_name()
        if name:
            return name
    except Exception:
        pass
    try:
        return time.tzname[0] or "UTC"
    except Exception:
        return "UTC"


def resolve_locale(gateway: SettingsGateway = DEFAULT_SETTINGS_GATEWAY) -> str:
    """Best-effort BCP-47 locale, settings-first then OS, defaulting to en-US."""
    try:
        loc = getattr(gateway.load(), "locale", None)
        if loc:
            return loc
    except Exception:
        pass
    try:
        import locale
        code = locale.getlocale()[0]
        if code:
            return code.replace("_", "-")
    except Exception:
        pass
    return "en-US"

test_sink: Optional[Any] = None
install_id: Optional[str] = None
p_user_id: Optional[str] = None
p_inflight = 0
p_inflight_lock = asyncio.Lock()
p_drain_lock = asyncio.Lock()


def spool_path() -> str:
    try:
        from backend.config.paths import SETTINGS_DIR
        return os.path.join(SETTINGS_DIR, "service_spool.db")
    except Exception:
        return os.path.expanduser("~/.openswarm/data/service_spool.db")


def set_test_sink(fn: Optional[Any]) -> None:
    """Test seam; receives every submission instead of the network."""
    global test_sink
    test_sink = fn


def p_get_install_id(gateway: SettingsGateway = DEFAULT_SETTINGS_GATEWAY) -> str:
    global install_id
    if install_id:
        return install_id
    try:
        s = gateway.load()
        iid = getattr(s, "installation_id", None)
        if not iid:
            iid = uuid4().hex
            s.installation_id = iid
            gateway.save(s)
        install_id = iid
    except Exception:
        install_id = uuid4().hex
    return install_id


def p_get_user_id(gateway: SettingsGateway = DEFAULT_SETTINGS_GATEWAY) -> Optional[str]:
    global p_user_id
    if p_user_id:
        return p_user_id
    try:
        s = gateway.load()
        # Prefer the cloud-issued user_id (UUID) if the user has signed in via Google OAuth, magic link, or Stripe checkout; that's the authoritative identity. Falls back to user_email for installs that haven't completed sign-in yet (so existing onboarding-only installs don't lose their Person history during the v1.0.29 rollout). After every install signs in, this fallback drops out.
        return (
            getattr(s, "user_id", None)
            or getattr(s, "user_email", None)
            or None
        )
    except Exception:
        return None


def set_user_id(uid: Optional[str]) -> None:
    global p_user_id
    p_user_id = uid or None


def p_is_enabled(kind: str, gateway: SettingsGateway = DEFAULT_SETTINGS_GATEWAY) -> bool:
    """Honour user opt-out. Diagnostic always flows (errors block usability);
    state + session honour the toggle."""
    if kind == "diagnostic":
        return True
    try:
        s = gateway.load()
        mode = getattr(s, "service_diagnostics_mode", None)
        if mode == "minimal":
            return False
        if mode is None:
            return bool(getattr(s, "analytics_opt_in", True))
        return True
    except Exception:
        return True


def p_envelope(gateway: SettingsGateway = DEFAULT_SETTINGS_GATEWAY) -> dict:
    """Identity + environment metadata stamped on every submission."""
    env: dict[str, Any] = {"install_id": p_get_install_id(gateway)}
    uid = p_get_user_id(gateway)
    if uid:
        env["user_id"] = uid
    try:
        env["os"] = platform.system()
        env["os_version"] = platform.release()
        env["device_type"] = "desktop"
    except Exception:
        pass
    # Timezone: prefer the IANA zone name passed in by Electron (always canonical, e.g. "America/Los_Angeles") so cloud-side localTimeFields() can format hour-of-day correctly. Fall back to Python's local zone which sometimes returns abbreviations (PDT, CDT) or localized names ("Romance (zomertijd)") that don't round-trip through tzdata.
    try:
        ianatz = os.environ.get("OPENSWARM_TIMEZONE", "").strip()
        if not ianatz:
            try:
                from tzlocal import get_localzone_name  # type: ignore
                ianatz = get_localzone_name() or ""
            except Exception:
                pass
        if not ianatz:
            import datetime as p_dt
            local_tz = p_dt.datetime.now().astimezone().tzinfo
            if local_tz:
                ianatz = str(local_tz)
        if ianatz:
            env["timezone"] = ianatz
    except Exception:
        pass
    # Locale: BCP 47 string ("en-US", "es-ES", etc.) injected by Electron via app.getLocale(); see electron/main.js. We don't fall back to Python's locale.getdefaultlocale() because that's deprecated, often empty, and returns inconsistent OS-specific values across macOS/Windows/Linux.
    try:
        loc = os.environ.get("OPENSWARM_LOCALE", "").strip()
        if loc:
            env["locale"] = loc
    except Exception:
        pass
    env["app_version"] = APP_VERSION
    # How this build was packaged. Set by the platform-specific build script (electron-builder afterPack hooks for dmg / exe / appimage / deb / rpm). Defaults to "dev" when running from `bash run.sh` in a checked-out repo.
    env["install_method"] = os.environ.get("OPENSWARM_INSTALL_METHOD", "dev")
    return env


def p_base_url(gateway: SettingsGateway = DEFAULT_SETTINGS_GATEWAY) -> str:
    try:
        s = gateway.load()
        return (getattr(s, "openswarm_proxy_url", None) or gateway.default_proxy_url()).rstrip("/")
    except Exception:
        return P_DEFAULT_BASE


async def p_post(path: str, body: dict, gateway: SettingsGateway = DEFAULT_SETTINGS_GATEWAY) -> int | None:
    url = f"{p_base_url(gateway)}{path}"
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


def p_redact_sync_body(body: dict) -> dict:
    """Sanitize a service-sync envelope before network or retry persistence."""
    safe = redact_settings(body)
    payload = body.get("d")
    if isinstance(payload, dict):
        safe["d"] = redact_settings(payload)
    return safe


async def p_post_or_spool(path: str, body: dict, kind: str, gateway: SettingsGateway = DEFAULT_SETTINGS_GATEWAY) -> None:
    global p_inflight
    safe_body = p_redact_sync_body(body)
    if test_sink is not None:
        try:
            test_sink(kind, safe_body)
        except Exception as e:
            logger.debug("test sink raised: %s", e)
        return
    async with p_inflight_lock:
        if p_inflight >= P_MAX_INFLIGHT:
            buffer.enqueue(spool_path(), f"{kind}:{path}", safe_body, now=time.time())
            return
        p_inflight += 1
    try:
        status = await p_post(path, safe_body, gateway)
        if p_retryable(status):
            buffer.enqueue(spool_path(), f"{kind}:{path}", safe_body, now=time.time())
        elif not p_delivered(status):
            logger.warning("service POST %s rejected with HTTP %s; payload dropped", path, status)
    finally:
        async with p_inflight_lock:
            p_inflight = max(0, p_inflight - 1)


async def drain_spool(batch_size: int = 50, gateway: SettingsGateway = DEFAULT_SETTINGS_GATEWAY) -> int:
    async with p_drain_lock:
        entries = buffer.drain(spool_path(), batch_size=batch_size)
        if not entries:
            return 0
        succeeded: list[int] = []
        for rid, kind_path, body in entries:
            kind, _, path = kind_path.partition(":")
            if not path:
                succeeded.append(rid)
                continue
            status = await p_post(path, body, gateway)
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


# -------------------------------------------------------------------------- Public API --------------------------------------------------------------------------

def p_log(kind: str, payload: dict) -> None:
    """Append to the rolling operational log for diagnostics."""
    try:
        from backend.apps.service.ring_buffer import record
        record(kind)
    except Exception:
        pass


def sync(data: dict | None = None, gateway: SettingsGateway = DEFAULT_SETTINGS_GATEWAY) -> None:
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
    if not p_is_enabled("state", gateway):
        return
    body = {
        "client_state": p_envelope(gateway),
        "d": payload,
        "t": time.time(),
        "submission_id": uuid4().hex,
    }
    p_log("s", payload)
    if test_sink is not None:
        try:
            test_sink("s", p_redact_sync_body(body))
        except Exception as e:
            logger.debug("test sink raised: %s", e)
        return
    p_schedule(p_post_or_spool(P_DEFAULT_SYNC_PATH, body, "s", gateway))


# Internal routing; the cloud has one endpoint for everything.
P_DEFAULT_SYNC_PATH = "/api/service/sync"


def submit(kind: str, payload: dict) -> None:
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

    def p_run():
        try:
            asyncio.run(coro)
        except Exception:
            pass

    threading.Thread(target=p_run, daemon=True).start()


# -------------------------------------------------------------------------- Backwards-compat shims for legacy call sites. New code calls submit() directly. These keep the ~50 existing import sites in the codebase working unchanged. Removed in a future cleanup once nothing imports from older import paths. --------------------------------------------------------------------------

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
    # The local flight file: every diagnostic also lands in a rotating NDJSON when the sink is set,
    # so support is "send me one file" and forced-failure tests can verify envelopes offline.
    sink = os.environ.get("OPENSWARM_DIAG_SINK")
    if sink:
        try:
            import json as p_json
            if os.path.exists(sink) and os.path.getsize(sink) > 1_000_000:
                os.replace(sink, sink + ".0")
            with open(sink, "a", encoding="utf-8") as f:
                f.write(p_json.dumps({"t": time.time(), **diagnostic}, default=str) + "\n")
        except OSError:
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
