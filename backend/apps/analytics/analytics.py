"""Analytics SubApp: PostHog for product analytics + local usage summary from session data."""

import asyncio
import json
import logging
import os
import platform
from collections import Counter
from contextlib import asynccontextmanager
from datetime import datetime

from backend.config.Apps import SubApp
from backend.config.paths import SESSIONS_DIR
from backend.apps.analytics.collector import init as init_collector, shutdown as shutdown_collector, record, identify

logger = logging.getLogger(__name__)

APP_VERSION = "1.0.20"

_heartbeat_task: asyncio.Task | None = None

# Delta tracking — tracks last-seen 9Router totals to compute increments
_last_9r_cost: float | None = None
_last_9r_prompt_tokens: int | None = None
_last_9r_completion_tokens: int | None = None
_last_9r_requests: int | None = None
_RESTART_THRESHOLD = 1.0


def _compute_delta(current: float, last: float | None, threshold: float = _RESTART_THRESHOLD) -> tuple[float, float]:
    """Compute incremental delta from cumulative values.

    Returns (delta, new_last).
    Handles 9Router restarts (large drops) and float jitter (tiny drops).
    """
    if last is None:
        return 0.0, current
    if current < last - threshold:
        return current, current
    if current < last:
        return 0.0, last
    return current - last, current


async def _heartbeat_loop():
    """Send a heartbeat event every 60 seconds with cost/token deltas."""
    global _last_9r_cost, _last_9r_prompt_tokens, _last_9r_completion_tokens, _last_9r_requests

    while True:
        await asyncio.sleep(60)
        try:
            from backend.apps.agents.agent_manager import agent_manager
            props = {
                "active_session_count": len(agent_manager.sessions),
            }

            # Compute cost/token deltas from 9Router
            try:
                from backend.apps.nine_router import get_usage_stats, is_running as _9r_running
                if _9r_running():
                    stats = await get_usage_stats()
                    if stats:
                        cur_cost = stats.get("totalCost", 0) or 0
                        cur_prompt = stats.get("totalPromptTokens", 0) or 0
                        cur_completion = stats.get("totalCompletionTokens", 0) or 0
                        cur_requests = stats.get("totalRequests", 0) or 0

                        cost_delta, _last_9r_cost = _compute_delta(cur_cost, _last_9r_cost)
                        prompt_delta, _last_9r_prompt_tokens = _compute_delta(cur_prompt, _last_9r_prompt_tokens, threshold=1000)
                        completion_delta, _last_9r_completion_tokens = _compute_delta(cur_completion, _last_9r_completion_tokens, threshold=1000)
                        requests_delta, _last_9r_requests = _compute_delta(cur_requests, _last_9r_requests, threshold=10)

                        props["nine_router_total_cost"] = cur_cost
                        props["nine_router_total_prompt_tokens"] = cur_prompt
                        props["nine_router_total_completion_tokens"] = cur_completion

                        # Per-model breakdown
                        for model_name, model_data in (stats.get("byModel") or {}).items():
                            safe_name = model_name.replace(".", "_").replace("-", "_")[:40]
                            props[f"cost_model_{safe_name}"] = model_data.get("cost", 0)
            except Exception:
                pass

            record("app.heartbeat", props)

            # Fire cost.delta with incremental amounts
            if "nine_router_total_cost" in props:
                record("cost.delta", {
                    "cost_delta_usd": cost_delta,
                    "prompt_tokens_delta": int(prompt_delta),
                    "completion_tokens_delta": int(completion_delta),
                    "requests_delta": int(requests_delta),
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

        # Track first open
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

        id_props = {
            "providers_configured": providers,
            "provider_count": len(providers),
            "app_version": APP_VERSION,
        }
        if getattr(settings, "user_email", None):
            id_props["email"] = settings.user_email
        if getattr(settings, "user_name", None):
            id_props["name"] = settings.user_name
        if getattr(settings, "user_use_case", None):
            id_props["use_case"] = settings.user_use_case
        identify(id_props)
    except Exception as e:
        logger.debug(f"Analytics startup event failed (non-critical): {e}")

    # Auto-start 9Router for subscription access
    try:
        from backend.apps.nine_router import ensure_running as ensure_9router
        await ensure_9router()
    except Exception as e:
        logger.debug(f"9Router auto-start skipped: {e}")

    # Start heartbeat
    _heartbeat_task = asyncio.create_task(_heartbeat_loop())

    yield

    # Stop heartbeat
    if _heartbeat_task:
        _heartbeat_task.cancel()
        try:
            await _heartbeat_task
        except asyncio.CancelledError:
            pass
        _heartbeat_task = None

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


@analytics.router.post("/event")
async def record_event(body: dict):
    """Accept analytics events from the frontend (e.g. feature.time_spent)."""
    event_type = body.get("event_type", "")
    properties = body.get("properties", {})
    if event_type:
        record(event_type, properties,
               session_id=body.get("session_id"),
               dashboard_id=body.get("dashboard_id"))
    return {"ok": True}
