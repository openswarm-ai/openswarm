"""Session-level aggregation logic for the usage-summary endpoint."""

from __future__ import annotations

import json
import os
from collections import Counter
from datetime import datetime

from backend.config.paths import SESSIONS_DIR


def load_all_sessions() -> list[dict]:
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


def compute_session_stats(sessions: list[dict]) -> dict:
    """Aggregate counters and durations from a list of session dicts."""
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

        for m in tool_msgs:
            content = m.get("content", {})
            if isinstance(content, dict):
                tool_name = content.get("tool", "")
                if tool_name:
                    tool_counts[tool_name] += 1

    avg_duration = total_duration / total_sessions if total_sessions > 0 else 0
    completed = status_counts.get("completed", 0)
    completion_rate = completed / total_sessions if total_sessions > 0 else 0

    return {
        "total_sessions": total_sessions,
        "total_cost_usd": total_cost,
        "total_messages": total_messages,
        "total_tool_calls": total_tool_calls,
        "avg_duration_seconds": avg_duration,
        "completion_rate": completion_rate,
        "models_used": dict(model_counts.most_common(10)),
        "providers_used": dict(provider_counts.most_common(10)),
        "top_tools": dict(tool_counts.most_common(15)),
        "status_breakdown": dict(status_counts),
    }


def enrich_with_nine_router(stats: dict, nine_router_stats: dict | None) -> dict:
    """Merge 9Router cost/token data into the aggregated stats dict."""
    total_cost = stats["total_cost_usd"]
    total_sessions = stats["total_sessions"]

    if nine_router_stats and nine_router_stats.get("totalCost", 0) > 0:
        cost_source = "9router"
        total_cost = nine_router_stats["totalCost"]
    elif total_cost > 0:
        cost_source = "sdk"
    else:
        cost_source = "none"

    avg_cost = total_cost / total_sessions if total_sessions > 0 else 0

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
        **stats,
        "total_cost_usd": round(total_cost, 4),
        "avg_duration_seconds": round(stats["avg_duration_seconds"], 1),
        "avg_cost_per_session": round(avg_cost, 4),
        "completion_rate": round(stats["completion_rate"], 3),
        "total_prompt_tokens": total_prompt_tokens,
        "total_completion_tokens": total_completion_tokens,
        "cost_by_model": cost_by_model,
        "cost_by_provider": cost_by_provider,
        "cost_source": cost_source,
        "nine_router_available": nine_router_stats is not None,
        "total_requests": total_requests,
    }
