"""Analytics SubApp: PostHog for product analytics + local usage summary from session data."""

import asyncio
import logging
import platform
from contextlib import asynccontextmanager
from datetime import datetime

from backend.config.Apps import SubApp
from backend.apps.analytics.collector import init as init_collector, shutdown as shutdown_collector, record, identify
from backend.apps.analytics.usage_summary import load_all_sessions, compute_session_stats, enrich_with_nine_router

logger = logging.getLogger(__name__)

APP_VERSION = "1.0.20"

_heartbeat_task: asyncio.Task | None = None


async def _heartbeat_loop():
    """Send a heartbeat event every 60 seconds for usage-time tracking and cost snapshots."""
    while True:
        await asyncio.sleep(60)
        try:
            from backend.apps.agents.agent_manager import agent_manager
            props = {
                "active_session_count": len(agent_manager.sessions),
            }

            try:
                from backend.apps.nine_router import get_usage_stats, is_running as _9r_running
                if _9r_running():
                    stats = await get_usage_stats()
                    if stats:
                        props["nine_router_total_cost"] = stats.get("totalCost", 0)
                        props["nine_router_total_prompt_tokens"] = stats.get("totalPromptTokens", 0)
                        props["nine_router_total_completion_tokens"] = stats.get("totalCompletionTokens", 0)
                        props["nine_router_total_requests"] = stats.get("totalRequests", 0)
                        for model_name, model_data in (stats.get("byModel") or {}).items():
                            safe_name = model_name.replace(".", "_").replace("-", "_")[:40]
                            props[f"cost_model_{safe_name}"] = model_data.get("cost", 0)
                            props[f"tokens_model_{safe_name}"] = model_data.get("promptTokens", 0) + model_data.get("completionTokens", 0)
            except Exception:
                pass

            record("app.heartbeat", props)

            if "nine_router_total_cost" in props:
                record("cost.snapshot", {
                    "total_cost_usd": props["nine_router_total_cost"],
                    "total_prompt_tokens": props.get("nine_router_total_prompt_tokens", 0),
                    "total_completion_tokens": props.get("nine_router_total_completion_tokens", 0),
                    "total_requests": props.get("nine_router_total_requests", 0),
                })
        except Exception:
            pass


@asynccontextmanager
async def analytics_lifespan():
    global _heartbeat_task

    init_collector()
    logger.info("PostHog analytics initialised")

    try:
        from backend.apps.settings.settings import load_settings, _save_settings
        settings = load_settings()

        is_first_open = settings.first_opened_at is None
        if is_first_open:
            settings.first_opened_at = datetime.now().isoformat()
            _save_settings(settings)

        days_since_install = 0
        if settings.first_opened_at:
            try:
                first = datetime.fromisoformat(settings.first_opened_at[:19])
                days_since_install = (datetime.now() - first).days
            except Exception:
                pass

        providers = []
        if getattr(settings, "anthropic_api_key", None):
            providers.append("anthropic")
        if getattr(settings, "openai_api_key", None):
            providers.append("openai")
        if getattr(settings, "google_api_key", None):
            providers.append("gemini")
        if getattr(settings, "openrouter_api_key", None):
            providers.append("openrouter")
        for cp in getattr(settings, "custom_providers", []):
            providers.append(cp.name)

        record("app.opened", {
            "os": platform.system(),
            "platform": platform.platform(),
            "provider_count": len(providers),
            "providers": providers,
            "is_first_open": is_first_open,
            "days_since_install": days_since_install,
            "app_version": APP_VERSION,
        })

        identify({
            "providers_configured": providers,
            "provider_count": len(providers),
            "app_version": APP_VERSION,
        })
    except Exception as e:
        logger.debug(f"Analytics startup event failed (non-critical): {e}")

    _heartbeat_task = asyncio.create_task(_heartbeat_loop())

    yield

    if _heartbeat_task:
        _heartbeat_task.cancel()
        try:
            await _heartbeat_task
        except asyncio.CancelledError:
            pass
        _heartbeat_task = None

    shutdown_collector()
    logger.info("PostHog analytics shut down")


analytics = SubApp("analytics", analytics_lifespan)


@analytics.router.get("/usage-summary")
async def usage_summary():
    """Compute usage stats from persisted sessions for the Settings page."""
    from backend.apps.agents.agent_manager import agent_manager
    from backend.apps.nine_router import get_usage_stats, is_running as _9r_running

    sessions = load_all_sessions()
    for s in agent_manager.get_all_sessions():
        sessions.append(s.model_dump(mode="json"))

    stats = compute_session_stats(sessions)
    nine_router_stats = await get_usage_stats() if _9r_running() else None
    return enrich_with_nine_router(stats, nine_router_stats)