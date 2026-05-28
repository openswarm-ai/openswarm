"""Service SubApp.

Replaces the former analytics SubApp with operationally-named endpoints
and lifecycle management. Responsibilities:

  - Usage-summary and cost-breakdown endpoints (user-facing, for the
    Settings / Usage page)
  - Background heartbeat that reports operational state to the cloud
  - 9Router auto-start for OpenSwarm Pro users
  - Frontend event endpoint (`POST /api/service/event`)
  - Periodic spool drainer for offline retry
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import platform
from collections import Counter
from contextlib import asynccontextmanager
from datetime import datetime

from fastapi import Body

from backend.config.Apps import SubApp
from backend.config.paths import SESSIONS_DIR
from backend.apps.service import client as svc
from backend.apps.service.version import APP_VERSION, _read_app_version

logger = logging.getLogger(__name__)

_pulse_task: asyncio.Task | None = None
_drain_task: asyncio.Task | None = None

_last_9r_cost: float | None = None
_last_9r_prompt_tokens: int | None = None
_last_9r_completion_tokens: int | None = None
_last_9r_requests: int | None = None
_RESTART_THRESHOLD = 1.0


def _compute_delta(current: float, last: float | None, threshold: float = _RESTART_THRESHOLD) -> tuple[float, float]:
    if last is None:
        return 0.0, current
    if current < last - threshold:
        return current, current
    if current < last:
        return 0.0, last
    return current - last, current


_pulse_count = 0
_pulse_hours: set = set()
_pulse_delta_cost_total = 0.0
_pulse_batch_size = 10


async def _pulse_loop():
    """Periodic state-pulse loop. Every minute, samples local counters
    (active sessions, hour bucket, 9Router cost). Every N samples, ships
    a compact state struct to the cloud for billing reconciliation."""
    global _last_9r_cost, _last_9r_prompt_tokens, _last_9r_completion_tokens, _last_9r_requests
    global _pulse_count, _pulse_hours, _pulse_delta_cost_total

    while True:
        await asyncio.sleep(60)
        _pulse_count += 1
        try:
            import datetime as _dt
            _pulse_hours.add(_dt.datetime.now().hour)
        except Exception:
            pass

        cost_delta = 0.0
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
                    _pulse_delta_cost_total += cost_delta
        except Exception:
            pass

        if _pulse_count >= _pulse_batch_size:
            try:
                from backend.apps.agents.agent_manager import agent_manager
                # Compact field names; the wire stays small and the cloud
                # is the only place that knows what each key means.
                svc.sync({
                    "a": len(agent_manager.sessions),       # active sessions
                    "h": sorted(_pulse_hours),               # hour bucket set
                    "n": _pulse_count,                       # samples in batch
                    "c": _last_9r_cost or 0,                 # cumulative cost
                    "d1": _pulse_delta_cost_total,           # cost delta since last batch
                })
            except Exception:
                pass
            _pulse_count = 0
            _pulse_hours = set()
            _pulse_delta_cost_total = 0.0


async def _drain_loop():
    while True:
        try:
            await svc.drain_spool()
        except Exception:
            pass
        await asyncio.sleep(60)


@asynccontextmanager
async def service_lifespan():
    global _pulse_task, _drain_task

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

        svc.sync({
            "os": platform.system(),
            "platform": platform.platform(),
            "provider_count": len(providers),
            "providers": providers,
            "is_first_open": is_first_open,
            "days_since_install": days_since_install,
            "app_version": APP_VERSION,
        })

        id_props: dict = {
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
        if getattr(settings, "user_referral_source", None):
            id_props["referral_source"] = settings.user_referral_source

        mode = getattr(settings, "connection_mode", "own_key")
        plan = getattr(settings, "openswarm_subscription_plan", None)
        is_paying = mode == "openswarm-pro" and bool(
            getattr(settings, "openswarm_bearer_token", None)
        )
        id_props["connection_mode"] = mode
        id_props["plan"] = plan if is_paying else "free"
        id_props["is_paying_customer"] = is_paying
        if is_paying and getattr(settings, "openswarm_subscription_expires", None):
            id_props["subscription_expires"] = settings.openswarm_subscription_expires

        svc.sync({"identity": id_props})
    except Exception as e:
        logger.debug(f"Service startup event failed (non-critical): {e}")

    try:
        from backend.apps.nine_router import ensure_running as ensure_9router
        await ensure_9router()
    except Exception as e:
        logger.debug(f"9Router auto-start skipped: {e}")

    _pulse_task = asyncio.create_task(_pulse_loop())
    _drain_task = asyncio.create_task(_drain_loop())

    yield

    if _pulse_task:
        _pulse_task.cancel()
        try:
            await _pulse_task
        except asyncio.CancelledError:
            pass
        _pulse_task = None

    if _drain_task:
        _drain_task.cancel()
        try:
            await _drain_task
        except asyncio.CancelledError:
            pass
        _drain_task = None

    try:
        from backend.apps.nine_router import stop as stop_9router
        stop_9router()
    except Exception:
        pass

    logger.info("Service shut down")


service = SubApp("service", service_lifespan)


# ---------------------------------------------------------------------------
# Usage endpoints (user-facing, read by the Settings / Usage page)
# ---------------------------------------------------------------------------

def _load_all_sessions() -> list[dict]:
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


@service.router.get("/usage-summary")
async def usage_summary():
    from backend.apps.agents.agent_manager import agent_manager

    sessions = _load_all_sessions()
    for s in agent_manager.get_all_sessions():
        sessions.append(s.model_dump(mode="json"))

    def _is_real(sess: dict) -> bool:
        # "Real" = actually ran. Empty draft/abandoned sessions (no assistant turn, no tokens,
        # no active time) otherwise inflate the count and drag every average toward zero.
        if (sess.get("agent_active_ms") or 0) > 0 or (sess.get("cost_usd") or 0) > 0:
            return True
        tk = sess.get("tokens") or {}
        if (tk.get("input") or 0) > 0 or (tk.get("output") or 0) > 0:
            return True
        return any(m.get("role") == "assistant" for m in sess.get("messages", []))

    sessions = [s for s in sessions if _is_real(s)]

    total_sessions = len(sessions)
    total_cost = sum(s.get("cost_usd", 0) for s in sessions)
    total_messages = 0
    total_tool_calls = 0
    total_run_seconds = 0.0
    timed_sessions = 0
    model_counts: Counter = Counter()
    provider_counts: Counter = Counter()
    tool_counts: Counter = Counter()
    status_counts: Counter = Counter()

    for s in sessions:
        messages = s.get("messages", [])
        total_messages += sum(1 for m in messages if m.get("role") in ("user", "assistant"))
        model_counts[s.get("model", "unknown")] += 1
        provider_counts[s.get("provider", "anthropic")] += 1
        status_counts[s.get("status", "unknown")] += 1

        # Tool calls: tool_latencies carries authoritative per-tool counts; older sessions only have
        # the sparse tool_call messages. Per session take whichever source recorded more so we never
        # undercount what's on record (and so the total never drops below the old message-only count).
        lat_counts: Counter = Counter()
        for tool, d in (s.get("tool_latencies") or {}).items():
            cnt = (d or {}).get("count", 0) or 0
            if tool and cnt:
                lat_counts[tool] += cnt
        msg_counts: Counter = Counter()
        for m in messages:
            if m.get("role") == "tool_call":
                content = m.get("content", {})
                name = content.get("tool") if isinstance(content, dict) else None
                msg_counts[name or "tool"] += 1
        chosen = lat_counts if sum(lat_counts.values()) >= sum(msg_counts.values()) else msg_counts
        total_tool_calls += sum(chosen.values())
        tool_counts.update(chosen)

        # Run time: real agent-active time when tracked, else session wall-clock as a rough proxy.
        run_s = (s.get("agent_active_ms") or 0) / 1000.0
        if run_s <= 0:
            created, closed = s.get("created_at"), s.get("closed_at")
            if created and closed:
                try:
                    run_s = (datetime.fromisoformat(closed[:19]) - datetime.fromisoformat(created[:19])).total_seconds()
                except Exception:
                    run_s = 0
        if run_s > 0:
            total_run_seconds += run_s
            timed_sessions += 1

    avg_duration = total_run_seconds / timed_sessions if timed_sessions > 0 else 0
    completed = status_counts.get("completed", 0)
    completion_rate = completed / total_sessions if total_sessions > 0 else 0

    from backend.apps.nine_router import get_usage_stats, is_running as _9r_running
    nine_router_stats = await get_usage_stats() if _9r_running() else None

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
        "total_sessions": total_sessions,
        "total_cost_usd": round(total_cost, 4),
        "total_messages": total_messages,
        "total_tool_calls": total_tool_calls,
        "total_run_seconds": round(total_run_seconds, 1),
        "avg_duration_seconds": round(avg_duration, 1),
        "avg_cost_per_session": round(avg_cost, 4),
        "completion_rate": round(completion_rate, 3),
        "models_used": dict(model_counts.most_common(10)),
        "providers_used": dict(provider_counts.most_common(10)),
        "top_tools": dict(tool_counts.most_common(15)),
        "status_breakdown": dict(status_counts),
        "total_prompt_tokens": total_prompt_tokens,
        "total_completion_tokens": total_completion_tokens,
        "cost_by_model": cost_by_model,
        "cost_by_provider": cost_by_provider,
        "cost_source": cost_source,
        "nine_router_available": nine_router_stats is not None,
        "total_requests": total_requests,
    }


@service.router.get("/cost-breakdown")
async def cost_breakdown(period: str = "7d"):
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


@service.router.get("/status")
async def service_status():
    return {"status": "ok", "enabled": True}


# ---------------------------------------------------------------------------
# Frontend event endpoints
# ---------------------------------------------------------------------------

@service.router.post("/submit")
async def post_submit(body=Body(...)):
    """Accepts three body shapes for backward compatibility:

    1. Frontend `report()` shape; flat `{s, a, p, submission_id, t}`.
       This is what `frontend/src/shared/serviceClient.ts:report()` sends
       on every UI interaction. Pass through unchanged so the cloud sees
       it as a frontend.event.

    2. Legacy `{kind, payload}` shape; used by older callers that wrapped
       the payload in a kind+payload envelope before submitting. Unwrap
       and forward the payload.

    3. Batched array; frontend collects up to 1s of events and sends them
       as a single JSON array to cut N POSTs/sec down to 1. Each item is
       processed exactly as if it had arrived as its own request.

    Pre-fix this endpoint required shape #2 and silently rejected shape #1
    with a 200 + `{ok:false}`, so every UI event from `report()` was
    dropped; `frontend.event` count was 0 in production analytics.
    """
    # Shape 3: batched array. Recurse per-item so single-item handling
    # logic stays in one place. Returns a single ok regardless of
    # individual item shape; analytics calls aren't transactional.
    if isinstance(body, list):
        for item in body:
            if isinstance(item, dict):
                if any(k in item for k in ("s", "a", "p")):
                    svc.sync(item)
                    continue
                kind = item.get("kind") or ""
                payload = item.get("payload") or {}
                if isinstance(payload, dict):
                    payload.setdefault("kind", kind)
                    svc.sync(payload)
        return {"ok": True}
    if not isinstance(body, dict):
        return {"ok": False, "error": "JSON object or array required"}
    # Shape 1: frontend `report()`; flat {s, a, p, ...}
    if any(k in body for k in ("s", "a", "p")):
        svc.sync(body)
        return {"ok": True}
    # Shape 2: legacy {kind, payload}
    kind = body.get("kind") or ""
    payload = body.get("payload")
    if kind and isinstance(payload, dict):
        svc.sync(payload)
        return {"ok": True}
    return {"ok": False, "error": "expected {s,a,p,...} or {kind,payload}"}


@service.router.post("/event")
async def post_event(body: dict):
    surface = body.get("surface") or body.get("event_type") or ""
    action = body.get("action") or ""

    # Legacy path: frontend sends {event_type: "foo.bar", properties: {...}}
    if not action and "." in surface:
        surface, action = surface.split(".", 1)
    if not surface:
        return {"ok": False, "error": "surface required"}
    if not action:
        action = "fired"

    svc.sync({
        "s": str(surface)[:64],
        "a": str(action)[:64],
        "p": body.get("props") or body.get("properties") or {},
    })
    return {"ok": True}


@service.router.get("/spool/count")
async def spool_count():
    from backend.apps.service import buffer
    return {"pending": buffer.count(svc._spool_path())}
