"""PostHog-only analytics collector.

All events go directly to PostHog. No local SQLite storage.

Usage from any module:
    from backend.apps.analytics.collector import record
    record("session.started", {"model": "opus"}, session_id="abc123")
"""

import logging
import platform
from uuid import uuid4

from posthog import Posthog

logger = logging.getLogger(__name__)

POSTHOG_API_KEY = "phc_KdVLvAdjCuHeacFoDm1CM1Gb23XikewRqlX67Mj6TNB"
POSTHOG_HOST = "https://us.i.posthog.com"

_posthog: Posthog | None = None
_installation_id: str | None = None


def init():
    """Initialise PostHog. Called once at app startup."""
    global _posthog
    if _posthog is None:
        _posthog = Posthog(
            project_api_key=POSTHOG_API_KEY,
            host=POSTHOG_HOST,
        )
    return _posthog


def shutdown():
    """Flush and close. Called at app shutdown."""
    global _posthog
    if _posthog:
        try:
            _posthog.shutdown()
        except Exception:
            pass
        _posthog = None


def _get_installation_id() -> str:
    """Get or create a stable anonymous installation ID."""
    global _installation_id
    if _installation_id:
        return _installation_id
    try:
        from backend.apps.settings.settings import load_settings, _save_settings
        settings = load_settings()
        iid = getattr(settings, "installation_id", None)
        if not iid:
            iid = uuid4().hex
            settings.installation_id = iid
            _save_settings(settings)
        _installation_id = iid
    except Exception:
        _installation_id = uuid4().hex
    return _installation_id


def _is_opted_in() -> bool:
    """Check if user has opted in to analytics."""
    try:
        from backend.apps.settings.settings import load_settings
        return getattr(load_settings(), "analytics_opt_in", True)
    except Exception:
        return True


def record(
    event_type: str,
    properties: dict | None = None,
    session_id: str | None = None,
    dashboard_id: str | None = None,
):
    """Record an analytics event to PostHog."""
    if not _posthog:
        return

    props = {**(properties or {})}
    if session_id:
        props["session_id"] = session_id
    if dashboard_id:
        props["dashboard_id"] = dashboard_id
    props["os"] = platform.system()
    props["platform"] = platform.platform()

    try:
        _posthog.capture(
            event_type,
            distinct_id=_get_installation_id(),
            properties=props,
        )
    except Exception as e:
        logger.debug(f"PostHog capture failed (non-critical): {e}")


def identify(extra_properties: dict | None = None):
    """Set person properties on the current installation's PostHog profile."""
    if not _posthog:
        return

    try:
        _posthog.set(
            distinct_id=_get_installation_id(),
            properties={
                "os": platform.system(),
                "platform": platform.platform(),
                **(extra_properties or {}),
            },
        )
    except Exception as e:
        logger.debug(f"PostHog identify failed (non-critical): {e}")


def get_collector():
    """Backward compat — returns None since we no longer have a local collector."""
    return None
