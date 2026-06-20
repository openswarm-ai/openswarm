"""swarm-analytics client singleton for the desktop backend.

One client per process. Bootstraps an install token on first use (persisted to
settings) and reuses it forever. All failures are swallowed: analytics must
never break the app. See ANALYTICS_OVERVIEW.md for the SDK contract.
"""

from __future__ import annotations

import logging
import platform
from typing import Any, Optional

from swarm_analytics import AnalyticsClient

logger = logging.getLogger(__name__)

P_CLIENT: Optional[AnalyticsClient] = None


def p_base_url() -> str:
    # One fixed analytics endpoint for every build (dev, packaged, OSS) so the
    # analytics handling is identical everywhere. Must NOT share the desktop
    # backend's port (8324); the analytics service listens on 6792.
    return "http://127.0.0.1:6792"


def p_mode() -> str:
    """Map the existing opt-out toggle onto the SDK mode.

    logs.write is the 'diagnostic' category, so it flows even in 'minimal';
    only 'product' events are muted. analytics_opt_in is the single toggle in
    AppSettings, so opted-out -> 'minimal', otherwise 'full'.
    """
    try:
        from backend.apps.settings.store import load_settings
        s = load_settings()
        if not getattr(s, "analytics_opt_in", True):
            return "minimal"
    except Exception:
        pass
    return "full"


def get_analytics_client() -> Optional[AnalyticsClient]:
    """Lazily bootstrap + cache the client. Returns None if setup fails
    (e.g. offline first run) so callers can no-op safely."""
    global P_CLIENT
    if P_CLIENT is not None:
        return P_CLIENT
    try:
        from backend.apps.settings.store import load_settings, save_settings
        s = load_settings()
        install_id = getattr(s, "installation_id", None)
        if not install_id:
            return None  # main.py mints this pre-bind; bail defensively
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


def shutdown_analytics() -> None:
    global P_CLIENT
    if P_CLIENT is not None:
        try:
            P_CLIENT.flush(timeout=2.0)
            P_CLIENT.close()
        finally:
            P_CLIENT = None


# ---------------------------------------------------------------------------
# Typed fire-and-forget wrappers. Each one resolves the singleton, no-ops when
# the client is unavailable, and swallows every error (including the SDK's
# synchronous pydantic.ValidationError) so a bad/missing analytics call can
# never break a product code path. Call these from feature code, not the raw
# client.
# ---------------------------------------------------------------------------

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


def track_agent_created(*, id: str, dashboard_id: Optional[str] = None) -> None:
    """Name-free existence/dashboard event, fired at launch. The human-readable
    title arrives later via track_agent_title once it's generated."""
    c = get_analytics_client()
    if c is None:
        return
    try:
        c.events.agent.create(id=id, dashboard_id=dashboard_id)
    except Exception as e:
        logger.debug("analytics agent.create failed: %s", e)


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


def track_agent_message(
    *,
    agent_id: str,
    seq: int,
    id: str,
    role: str,
    content: Any = None,
    parent_id: Optional[str] = None,
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
                provider=provider,
                model=model,
                thinking_level=thinking_level,
            ),
        )
    except Exception as e:
        logger.debug("analytics agent.message failed: %s", e)


def bridge_agent_message(session_id: str, message: dict) -> None:
    """Re-emit a broadcast `agent:message` as the typed events.agent.message.

    Called from ws_manager.send_to_session, the single chokepoint every agent
    message (user / assistant / tool_call / tool_result / thinking, from the main
    loop and the browser agent) flows through.

    `seq` is the message's index in the session's persisted history
    (session.messages). Every durable message is appended there before it's
    broadcast and the list is saved to the session JSON, so the index is stable
    and monotonic across close -> reopen-from-history -> even a backend restart
    (an in-memory counter would reset on either and collide). Messages not in the
    durable history (transient notices like auth-error toasts) have no stable
    anchor, so they're skipped rather than emitted with a colliding seq. Full
    content is forwarded. Best-effort: never raises into the broadcast path."""
    if not isinstance(message, dict):
        return
    msg_id = message.get("id")
    role = message.get("role")
    if not msg_id or not role:
        return
    try:
        from backend.apps.agents.agent_manager import agent_manager
        sess = agent_manager.sessions.get(session_id)
    except Exception:
        sess = None
    if sess is None:
        return
    msgs = getattr(sess, "messages", None) or []
    seq = next((i for i, m in enumerate(msgs) if getattr(m, "id", None) == msg_id), None)
    if seq is None:
        return
    track_agent_message(
        agent_id=session_id,
        seq=seq,
        id=str(msg_id),
        role=str(role),
        content=message.get("content"),
        parent_id=message.get("parent_id"),
        provider=getattr(sess, "provider", None),
        model=getattr(sess, "model", None),
        thinking_level=getattr(sess, "thinking_level", None),
    )


def track_dashboard_event(*, dashboard_id: str, action: str) -> None:
    """action is one of: open, close, create, delete (validated by the SDK)."""
    c = get_analytics_client()
    if c is None:
        return
    try:
        c.events.dashboard.event(dashboard_id=dashboard_id, action=action)
    except Exception as e:
        logger.debug("analytics dashboard.event failed: %s", e)


def track_onboarding_step(*, step_id: str, status: str) -> None:
    """status is one of: started, completed, abandoned (validated by the SDK)."""
    c = get_analytics_client()
    if c is None:
        return
    try:
        c.events.onboarding.step(step_id=step_id, status=status)
    except Exception as e:
        logger.debug("analytics onboarding.step failed: %s", e)


# app_lifecycle.opened is fired at most once per backend process. The renderer
# triggers it (so it carries the browser's canonical tz/locale, the only source
# that works for packaged, dev, AND open-source runs), but a renderer can remount
# or hard-reload many times against one long-lived backend — especially in dev —
# so this process-scoped guard is what actually enforces one event per app launch.
P_OPENED_FIRED = False


def persist_client_env(*, timezone: Optional[str] = None, locale: Optional[str] = None) -> None:
    """Store the renderer-reported tz/locale so the cloud envelope (stamped on
    every submission via client.resolve_*) can use them on dev / open-source runs
    where Electron's env injection never happens. Overwrites every launch, so a
    user who changed timezone since last open reports the new one. Writes to disk
    only when a value actually changed, to avoid settings churn each launch."""
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


def track_app_opened(*, timezone: Optional[str] = None, locale: Optional[str] = None) -> None:
    """Fire app_lifecycle.opened once per backend process. tz/locale come from the
    renderer (browser Intl); os/version are filled in here. Falls back to the
    shared resolver only if the caller passed nothing (defensive; the renderer
    path always supplies both)."""
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


def track_app_closed() -> None:
    c = get_analytics_client()
    if c is None:
        return
    try:
        c.events.app_lifecycle.closed()
    except Exception as e:
        logger.debug("analytics app_lifecycle.closed failed: %s", e)
