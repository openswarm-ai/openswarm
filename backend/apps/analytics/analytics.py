"""Analytics SubApp: PostHog for product analytics + local usage summary from session data."""

import json
import logging
import os
import platform
from collections import Counter
from contextlib import asynccontextmanager

from backend.config.Apps import SubApp
from backend.config.paths import SESSIONS_DIR
from backend.apps.analytics.collector import init as init_collector, shutdown as shutdown_collector, record, identify

logger = logging.getLogger(__name__)


@asynccontextmanager
async def analytics_lifespan():
    init_collector()
    logger.info("PostHog analytics initialised")

    try:
        from backend.apps.settings.settings import load_settings
        settings = load_settings()

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
        })

        identify({
            "providers_configured": providers,
            "provider_count": len(providers),
        })
    except Exception as e:
        logger.debug(f"Analytics startup event failed (non-critical): {e}")

    # Auto-start 9Router for subscription access
    try:
        from backend.apps.nine_router import ensure_running as ensure_9router
        await ensure_9router()
    except Exception as e:
        logger.debug(f"9Router auto-start skipped: {e}")

    yield

    # Stop 9Router
    try:
        from backend.apps.nine_router import stop as stop_9router
        stop_9router()
    except Exception:
        pass

    shutdown_collector()
    logger.info("PostHog analytics shut down")


analytics = SubApp("analytics", analytics_lifespan)


def _load_all_sessions() -> list[dict]:
    """Load all persisted session JSON files."""
    results = []
    if not os.path.exists(SESSIONS_DIR):
        return results
    for fname in os.listdir(SESSIONS_DIR):
        if fname.endswith(".json"):
            try:
                with open(os.path.join(SESSIONS_DIR, fname)) as f:
                    results.append(json.load(f))
            except Exception:
                pass
    return results


@analytics.router.get("/usage-summary")
async def usage_summary():
    """Compute usage stats from persisted sessions for the Settings page."""
    from backend.apps.agents.agent_manager import agent_manager

    # Combine persisted + active sessions
    sessions = _load_all_sessions()
    for s in agent_manager.get_all_sessions():
        sessions.append(s.model_dump(mode="json"))

    total_sessions = len(sessions)
    total_cost = sum(s.get("cost_usd", 0) for s in sessions)
    total_messages = 0
    total_tool_calls = 0
    total_duration = 0.0
    model_counts: Counter = Counter()
    provider_counts: Counter = Counter()
    tool_counts: Counter = Counter()
    status_counts: Counter = Counter()

    for s in sessions:
        messages = s.get("messages", [])
        user_msgs = [m for m in messages if m.get("role") in ("user", "assistant")]
        tool_msgs = [m for m in messages if m.get("role") == "tool_call"]
        total_messages += len(user_msgs)
        total_tool_calls += len(tool_msgs)

        model_counts[s.get("model", "unknown")] += 1
        provider_counts[s.get("provider", "anthropic")] += 1
        status_counts[s.get("status", "unknown")] += 1

        # Duration
        created = s.get("created_at")
        closed = s.get("closed_at")
        if created and closed:
            try:
                from datetime import datetime
                c_str = created[:19]
                cl_str = closed[:19]
                dur = (datetime.fromisoformat(cl_str) - datetime.fromisoformat(c_str)).total_seconds()
                if dur > 0:
                    total_duration += dur
            except Exception:
                pass

        # Count individual tools
        for m in tool_msgs:
            content = m.get("content", {})
            if isinstance(content, dict):
                tool_name = content.get("tool", "")
                if tool_name:
                    tool_counts[tool_name] += 1

    avg_duration = total_duration / total_sessions if total_sessions > 0 else 0
    completed = status_counts.get("completed", 0)
    completion_rate = completed / total_sessions if total_sessions > 0 else 0

    # Fetch 9Router usage data for accurate cost/token tracking
    from backend.apps.nine_router import get_usage_stats, is_running as _9r_running
    nine_router_stats = await get_usage_stats() if _9r_running() else None

    # Determine best cost source
    if nine_router_stats and nine_router_stats.get("totalCost", 0) > 0:
        cost_source = "9router"
        total_cost = nine_router_stats["totalCost"]
    elif total_cost > 0:
        cost_source = "sdk"
    else:
        cost_source = "none"

    avg_cost = total_cost / total_sessions if total_sessions > 0 else 0

    # Extract 9Router breakdowns
    cost_by_model = {}
    cost_by_provider = {}
    total_prompt_tokens = 0
    total_completion_tokens = 0
    total_requests = 0

    if nine_router_stats:
        total_prompt_tokens = nine_router_stats.get("totalPromptTokens", 0)
        total_completion_tokens = nine_router_stats.get("totalCompletionTokens", 0)
        total_requests = nine_router_stats.get("totalRequests", 0)
        for key, val in (nine_router_stats.get("byModel") or {}).items():
            cost_by_model[key] = {
                "cost": val.get("cost", 0),
                "requests": val.get("count", 0),
                "prompt_tokens": val.get("promptTokens", 0),
                "completion_tokens": val.get("completionTokens", 0),
            }
        for key, val in (nine_router_stats.get("byProvider") or {}).items():
            cost_by_provider[key] = {
                "cost": val.get("cost", 0),
                "requests": val.get("count", 0),
            }

    return {
        "total_sessions": total_sessions,
        "total_cost_usd": round(total_cost, 4),
        "total_messages": total_messages,
        "total_tool_calls": total_tool_calls,
        "avg_duration_seconds": round(avg_duration, 1),
        "avg_cost_per_session": round(avg_cost, 4),
        "completion_rate": round(completion_rate, 3),
        "models_used": dict(model_counts.most_common(10)),
        "providers_used": dict(provider_counts.most_common(10)),
        "top_tools": dict(tool_counts.most_common(15)),
        "status_breakdown": dict(status_counts),
        # 9Router enrichment
        "total_prompt_tokens": total_prompt_tokens,
        "total_completion_tokens": total_completion_tokens,
        "cost_by_model": cost_by_model,
        "cost_by_provider": cost_by_provider,
        "cost_source": cost_source,
        "nine_router_available": nine_router_stats is not None,
        "total_requests": total_requests,
    }


@analytics.router.get("/cost-breakdown")
async def cost_breakdown(period: str = "7d"):
    """Get detailed cost breakdown from 9Router."""
    from backend.apps.nine_router import get_usage_stats, is_running as _9r_running
    if not _9r_running():
        return {"available": False, "by_model": {}, "by_provider": {}}
    stats = await get_usage_stats(period)
    if not stats:
        return {"available": False, "by_model": {}, "by_provider": {}}
    return {
        "available": True,
        "period": period,
        "total_cost": stats.get("totalCost", 0),
        "total_requests": stats.get("totalRequests", 0),
        "total_prompt_tokens": stats.get("totalPromptTokens", 0),
        "total_completion_tokens": stats.get("totalCompletionTokens", 0),
        "by_model": stats.get("byModel", {}),
        "by_provider": stats.get("byProvider", {}),
    }


@analytics.router.get("/status")
async def analytics_status():
    return {"status": "posthog", "enabled": True}
