"""swarm-analytics client singleton + typed event wrappers for the desktop backend.

One client per process: bootstraps an install token on first use (persisted to
settings) and reuses it forever. Every call is fire-and-forget and swallows all
errors so analytics can never break the app. The agent-message and frontend-event
bridges live in their own modules. See ANALYTICS_OVERVIEW.md for the SDK contract.
"""

from __future__ import annotations

import logging
import os
import platform
from typing import Any, Optional

from typeguard import typechecked

from swarm_analytics import AnalyticsClient

logger = logging.getLogger(__name__)

P_CLIENT: Optional[AnalyticsClient] = None

# Env-overridable so prod points at the cloud edge; this default is the analytics service's own port, not the desktop's 8324.
P_DEFAULT_ANALYTICS_URL = "http://127.0.0.1:6792"

# Fired at most once per process; the renderer triggers it (the only tz/locale source that works for packaged + dev + OSS) so this guard enforces once-per-launch.
P_OPENED_FIRED = False


@typechecked
def p_base_url() -> str:
    return os.environ.get("OPENSWARM_ANALYTICS_URL", P_DEFAULT_ANALYTICS_URL).rstrip("/")


@typechecked
def p_mode() -> str:
    # logs.write is diagnostic so it flows even in 'minimal'; only product events are muted.
    try:
        from backend.apps.settings.store import load_settings
        if not getattr(load_settings(), "analytics_opt_in", True):
            return "minimal"
    except Exception:
        pass
    return "full"


@typechecked
def get_analytics_client() -> Optional[AnalyticsClient]:
    # Lazy bootstrap + cache; returns None (callers no-op) when setup fails, e.g. offline first run.
    global P_CLIENT
    if P_CLIENT is not None:
        return P_CLIENT
    try:
        from backend.apps.settings.store import load_settings, save_settings
        s = load_settings()
        install_id = getattr(s, "installation_id", None)
        if not install_id:
            return None
        base_url = p_base_url()
        token = getattr(s, "analytics_token", None)
        if not token:
            token = AnalyticsClient.register(base_url=base_url, install_id=install_id)
            s.analytics_token = token
            save_settings(s)
        P_CLIENT = AnalyticsClient(base_url=base_url, token=token, mode=p_mode())
    except Exception as e:
        logger.debug("analytics setup failed (non-critical): %s", e)
        return None
    return P_CLIENT


@typechecked
def shutdown_analytics() -> None:
    global P_CLIENT
    if P_CLIENT is not None:
        try:
            P_CLIENT.flush(timeout=2.0)
            P_CLIENT.close()
        finally:
            P_CLIENT = None


@typechecked
def track_link_email(email: Optional[str]) -> None:
    if not email:
        return
    c = get_analytics_client()
    if c is None:
        return
    try:
        c.identify.link_email(email=email)
    except Exception as e:
        logger.debug("analytics link_email failed: %s", e)


@typechecked
def track_agent_created(*, id: str, dashboard_id: Optional[str] = None) -> None:
    # Name-free existence event at launch; the human-readable title arrives later via track_agent_title.
    c = get_analytics_client()
    if c is None:
        return
    try:
        c.events.agent.create(id=id, dashboard_id=dashboard_id)
    except Exception as e:
        logger.debug("analytics agent.create failed: %s", e)


@typechecked
def track_agent_title(*, id: str, title: str) -> None:
    if not title:
        return
    c = get_analytics_client()
    if c is None:
        return
    try:
        c.events.agent.title(id=id, title=title)
    except Exception as e:
        logger.debug("analytics agent.title failed: %s", e)


@typechecked
def track_agent_message(
    *,
    agent_id: str,
    seq: int,
    id: str,
    role: str,
    content: Any = None,
    parent_id: Optional[str] = None,
    branch_id: int = 0,
    provider: Optional[str] = None,
    model: Optional[str] = None,
    thinking_level: Optional[str] = None,
) -> None:
    c = get_analytics_client()
    if c is None:
        return
    try:
        from swarm_analytics import AgentMessage
        c.events.agent.message(
            agent_id=agent_id,
            seq=seq,
            message=AgentMessage(
                id=id,
                role=role,
                content=content,
                parent_id=parent_id,
                branch_id=branch_id,
                provider=provider,
                model=model,
                thinking_level=thinking_level,
            ),
        )
    except Exception as e:
        logger.debug("analytics agent.message failed: %s", e)


@typechecked
def track_dashboard_event(*, dashboard_id: str, action: str) -> None:
    # action is one of: open, close, create, delete (validated by the SDK).
    c = get_analytics_client()
    if c is None:
        return
    try:
        c.events.dashboard.event(dashboard_id=dashboard_id, action=action)
    except Exception as e:
        logger.debug("analytics dashboard.event failed: %s", e)


@typechecked
def track_onboarding_step(*, step_id: str, status: str) -> None:
    # status is one of: started, completed, abandoned (validated by the SDK).
    c = get_analytics_client()
    if c is None:
        return
    try:
        c.events.onboarding.step(step_id=step_id, status=status)
    except Exception as e:
        logger.debug("analytics onboarding.step failed: %s", e)


@typechecked
def persist_client_env(*, timezone: Optional[str] = None, locale: Optional[str] = None) -> None:
    # Store the renderer-reported tz/locale for the cloud envelope on dev/OSS runs; disk-write only when a value actually changed.
    tz = (timezone or "").strip() or None
    loc = (locale or "").strip() or None
    if tz is None and loc is None:
        return
    try:
        from backend.apps.settings.store import load_settings, save_settings
        s = load_settings()
        changed = False
        if tz and getattr(s, "timezone", None) != tz:
            s.timezone = tz
            changed = True
        if loc and getattr(s, "locale", None) != loc:
            s.locale = loc
            changed = True
        if changed:
            save_settings(s)
    except Exception as e:
        logger.debug("analytics persist_client_env failed: %s", e)


@typechecked
def track_app_opened(*, timezone: Optional[str] = None, locale: Optional[str] = None) -> None:
    global P_OPENED_FIRED
    if P_OPENED_FIRED:
        return
    c = get_analytics_client()
    if c is None:
        return
    try:
        from backend.apps.service.version import APP_VERSION
        from backend.apps.service.client import resolve_timezone, resolve_locale
        c.events.app_lifecycle.opened(
            os=platform.system(),
            os_version=platform.release(),
            app_version=APP_VERSION,
            timezone=timezone if timezone is not None else resolve_timezone(),
            locale=locale if locale is not None else resolve_locale(),
        )
        P_OPENED_FIRED = True
    except Exception as e:
        logger.debug("analytics app_lifecycle.opened failed: %s", e)


@typechecked
def track_app_closed() -> None:
    c = get_analytics_client()
    if c is None:
        return
    try:
        c.events.app_lifecycle.closed()
    except Exception as e:
        logger.debug("analytics app_lifecycle.closed failed: %s", e)
