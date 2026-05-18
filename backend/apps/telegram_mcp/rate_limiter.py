"""
Rate limiter for Telegram MCP tools.

Why this exists: Telegram bans on spam patterns (rapid identical sends,
broad-pattern forwards, mass DMs to non-contacts). Proactive caps + jitter
keep an unsupervised agent well below the threshold that triggers a ban.

Caps are more generous than Instagram because Telegram is itself more
permissive, but still well under the "this is automation" line.

State persists across server restarts to ~/.telegram-mcp-rate-limits.json
so a relaunch does not reset the daily budget.

Per-category defaults:

  category   per_minute  per_hour  per_day  jitter
  send           30         200     1000    0.5-2.0s
  forward        20         150      600    0.5-2.0s
  search         60         500     3000    0.0-0.5s
  lookup         60         500     3000    0.0-0.5s

Override any cap via env var, e.g.:
  TG_RATE_LIMIT_SEND_PER_DAY=500
"""
from __future__ import annotations

import functools
import json
import logging
import os
import random
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Tuple

logger = logging.getLogger(__name__)

_STATE_PATH = Path.home() / ".telegram-mcp-rate-limits.json"

DEFAULTS: Dict[str, Dict[str, Any]] = {
    "send":    {"per_minute": 30, "per_hour": 200, "per_day": 1000, "jitter": (0.5, 2.0)},
    "forward": {"per_minute": 20, "per_hour": 150, "per_day": 600,  "jitter": (0.5, 2.0)},
    "search":  {"per_minute": 60, "per_hour": 500, "per_day": 3000, "jitter": (0.0, 0.5)},
    "lookup":  {"per_minute": 60, "per_hour": 500, "per_day": 3000, "jitter": (0.0, 0.5)},
}


def _env_override(category: str, key: str, default: int) -> int:
    var = f"TG_RATE_LIMIT_{category.upper()}_{key.upper()}"
    raw = os.environ.get(var)
    if raw is None:
        return default
    try:
        value = int(raw)
        if value <= 0:
            return default
        return value
    except ValueError:
        return default


def _get_limits(category: str) -> Dict[str, Any]:
    d = DEFAULTS[category]
    return {
        "per_minute": _env_override(category, "per_minute", d["per_minute"]),
        "per_hour":   _env_override(category, "per_hour",   d["per_hour"]),
        "per_day":    _env_override(category, "per_day",    d["per_day"]),
        "jitter":     d["jitter"],
    }


def _load_state() -> Dict[str, List[float]]:
    if not _STATE_PATH.exists():
        return {}
    try:
        data = json.loads(_STATE_PATH.read_text())
        return {k: [float(t) for t in v] for k, v in data.items() if isinstance(v, list)}
    except Exception as exc:
        logger.warning("Could not load rate-limit state, starting fresh: %s", exc)
        return {}


def _save_state(state: Dict[str, List[float]]) -> None:
    try:
        _STATE_PATH.write_text(json.dumps(state))
    except Exception as exc:
        logger.warning("Failed to persist rate-limit state: %s", exc)


def _prune(timestamps: List[float], now: float, window_s: int) -> List[float]:
    cutoff = now - window_s
    return [t for t in timestamps if t >= cutoff]


def _fmt_duration(seconds: int) -> str:
    if seconds < 60:
        return f"{seconds}s"
    if seconds < 3600:
        return f"{seconds // 60}m {seconds % 60}s"
    return f"{seconds // 3600}h {(seconds % 3600) // 60}m"


def _check_budget(
    category: str,
    limits: Dict[str, Any],
    state: Dict[str, List[float]],
) -> Tuple[bool, str, int, Dict[str, int]]:
    """Returns (ok, reason_if_blocked, retry_after_seconds, current_counts)."""
    now = time.time()
    pruned_day = _prune(state.get(category, []), now, 24 * 3600)
    state[category] = pruned_day

    counts: Dict[str, int] = {}
    for window_name, window_s in (("per_minute", 60), ("per_hour", 3600), ("per_day", 86400)):
        in_window = _prune(pruned_day, now, window_s)
        counts[window_name] = len(in_window)

    for window_name, window_s in (("per_minute", 60), ("per_hour", 3600), ("per_day", 86400)):
        in_window = _prune(pruned_day, now, window_s)
        limit = limits[window_name]
        if len(in_window) >= limit:
            oldest = min(in_window)
            retry_after = int((oldest + window_s) - now) + 1
            label = window_name.replace("per_", "")
            return (
                False,
                f"{category} hit {limit}/{label} cap (currently {len(in_window)}). Retry in {_fmt_duration(retry_after)}.",
                retry_after,
                counts,
            )
    return (True, "", 0, counts)


def rate_limited(category: str) -> Callable[[Callable[..., Dict[str, Any]]], Callable[..., Dict[str, Any]]]:
    """Decorator: enforce per-category limits and apply jitter before the call.

    Returns a structured error dict to the MCP client when blocked instead of
    raising, so the agent can surface "try again in 4h 12m" to the user
    instead of failing opaquely.
    """
    if category not in DEFAULTS:
        raise ValueError(f"Unknown rate-limit category: {category}")

    def decorator(func: Callable[..., Any]) -> Callable[..., Any]:
        # Telegram tools are all async (Telethon is async-only) so we
        # wrap with an async wrapper. Jitter uses asyncio.sleep so we don't
        # block the FastMCP event loop the way time.sleep would.
        import asyncio as _asyncio

        @functools.wraps(func)
        async def wrapper(*args: Any, **kwargs: Any) -> Dict[str, Any]:
            limits = _get_limits(category)
            state = _load_state()
            ok, reason, retry_after, current = _check_budget(category, limits, state)
            if not ok:
                logger.warning("Rate limit blocked %s: %s", func.__name__, reason)
                return {
                    "success": False,
                    "rate_limited": True,
                    "category": category,
                    "message": (
                        f"RATE LIMIT HIT — STOP HERE. {reason} DO NOT retry this tool. "
                        "DO NOT try alternative tools to accomplish the same goal. DO NOT "
                        "search the filesystem or look up the package source. Tell the user "
                        "the retry-after time in plain English and END the task. This "
                        "protects the Telegram account from being flagged for spam."
                    ),
                    "retry_after_seconds": retry_after,
                    "limits": {k: limits[k] for k in ("per_minute", "per_hour", "per_day")},
                    "current": current,
                }
            state.setdefault(category, []).append(time.time())
            _save_state(state)
            lo, hi = limits["jitter"]
            if hi > 0:
                await _asyncio.sleep(random.uniform(lo, hi))
            if _asyncio.iscoroutinefunction(func):
                return await func(*args, **kwargs)
            return func(*args, **kwargs)
        return wrapper
    return decorator
