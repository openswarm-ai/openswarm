"""OpenSwarm-side rate limiting for MCP tool calls.

Sits in the pre_tool_hook so we can refuse a call before the SDK proxies it
to the MCP server. Per-server, per-category caps + randomized jitter +
persistent state across OpenSwarm restarts.

Why this exists separately from per-server limiters: the LinkedIn upstream
(stickerdaniel/linkedin-mcp-server) only does reactive rate-limit detection
once LinkedIn already blocked us. We want proactive caps that stop us from
getting to that point. Same defense model as the vendored Instagram
server's built-in limiter, but at OpenSwarm's dispatch layer so we can
protect any third-party MCP server without forking it.

Servers with their own rigorous limiter (currently: Instagram) are
deliberately not in POLICIES here, to avoid double-throttling.
"""
from __future__ import annotations

import fnmatch
import json
import logging
import os
import random
import time
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

_STATE_PATH = Path.home() / ".openswarm" / "mcp-rate-limits.json"

# Per-MCP-server policy. Keys match the sanitized server name from the
# `mcp__<server>__<tool>` SDK format. Each tool pattern is glob-matched
# top-to-bottom; first match wins, "*" is the fallback.
POLICIES: dict[str, dict] = {
    "linkedin": {
        "categories": {
            "dm_send": {"per_minute": 2,  "per_hour": 20,  "per_day": 60,   "jitter": (1.5, 4.0)},
            "connect": {"per_minute": 1,  "per_hour": 10,  "per_day": 40,   "jitter": (2.0, 5.0)},
            "search":  {"per_minute": 10, "per_hour": 60,  "per_day": 300,  "jitter": (0.5, 2.0)},
            "lookup":  {"per_minute": 15, "per_hour": 120, "per_day": 600,  "jitter": (0.3, 1.0)},
        },
        "tools": [
            ("send_message",        "dm_send"),
            ("connect_with_person", "connect"),
            ("search_*",            "search"),
            ("*",                   "lookup"),
        ],
    },
    # Telegram has its own server-side rate limiter inside the vendored
    # package, so this entry is intentionally absent to avoid double-throttling.
    # If you want belt-and-suspenders, uncomment the block below:
    # "telegram": {
    #     "categories": {
    #         "send":    {"per_minute": 30, "per_hour": 200, "per_day": 1000, "jitter": (0.5, 2.0)},
    #         "forward": {"per_minute": 20, "per_hour": 150, "per_day": 600,  "jitter": (0.5, 2.0)},
    #         "search":  {"per_minute": 60, "per_hour": 500, "per_day": 3000, "jitter": (0.0, 0.5)},
    #         "lookup":  {"per_minute": 60, "per_hour": 500, "per_day": 3000, "jitter": (0.0, 0.5)},
    #     },
    #     "tools": [
    #         ("send_*",        "send"),
    #         ("forward_*",     "forward"),
    #         ("search_*",      "search"),
    #         ("*",             "lookup"),
    #     ],
    # },
}


def _env_override(server: str, category: str, key: str, default: int) -> int:
    var = f"{server.upper()}_RATE_LIMIT_{category.upper()}_{key.upper()}"
    raw = os.environ.get(var)
    if not raw:
        return default
    try:
        value = int(raw)
        return value if value > 0 else default
    except ValueError:
        return default


def _resolve(server: str, tool: str) -> tuple[str, dict] | None:
    policy = POLICIES.get(server.lower())
    if not policy:
        return None
    for pattern, cat in policy["tools"]:
        if fnmatch.fnmatch(tool, pattern):
            base = policy["categories"].get(cat)
            if not base:
                return None
            limits = {
                "per_minute": _env_override(server, cat, "per_minute", base["per_minute"]),
                "per_hour":   _env_override(server, cat, "per_hour",   base["per_hour"]),
                "per_day":    _env_override(server, cat, "per_day",    base["per_day"]),
                "jitter":     base["jitter"],
            }
            return (cat, limits)
    return None


def _load_state() -> dict[str, list[float]]:
    if not _STATE_PATH.exists():
        return {}
    try:
        data = json.loads(_STATE_PATH.read_text())
        return {k: [float(t) for t in v] for k, v in data.items() if isinstance(v, list)}
    except Exception:
        return {}


def _save_state(state: dict[str, list[float]]) -> None:
    try:
        _STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
        _STATE_PATH.write_text(json.dumps(state))
    except Exception as exc:
        logger.warning(f"Could not persist MCP rate-limit state: {exc}")


def _prune(timestamps: list[float], now: float, window_s: int) -> list[float]:
    cutoff = now - window_s
    return [t for t in timestamps if t >= cutoff]


def _fmt_duration(seconds: int) -> str:
    if seconds < 60:
        return f"{seconds}s"
    if seconds < 3600:
        return f"{seconds // 60}m {seconds % 60}s"
    return f"{seconds // 3600}h {(seconds % 3600) // 60}m"


def check(mcp_server: str, tool: str) -> dict[str, Any] | None:
    """Decide whether an MCP tool call should be allowed.

    Returns:
        None — no policy for this server (skip rate limiting entirely)
        {"allow": True, "jitter_s": float} — allow; caller should sleep that long
        {"deny": str, "retry_after_seconds": int} — block; caller should refuse
    """
    resolved = _resolve(mcp_server, tool)
    if not resolved:
        return None
    category, limits = resolved
    state_key = f"{mcp_server}:{category}"

    state = _load_state()
    now = time.time()
    stamps = _prune(state.get(state_key, []), now, 24 * 3600)

    for window_name, window_s in (("per_minute", 60), ("per_hour", 3600), ("per_day", 86400)):
        in_window = _prune(stamps, now, window_s)
        cap = limits[window_name]
        if len(in_window) >= cap:
            oldest = min(in_window)
            retry_after = int((oldest + window_s) - now) + 1
            label = window_name.replace("per_", "")
            reason = (
                f"RATE LIMIT HIT — STOP HERE. {mcp_server}/{category} cap of {cap}/{label} reached "
                f"(currently {len(in_window)}). The cap resets in {_fmt_duration(retry_after)}. "
                f"DO NOT retry this tool. DO NOT try alternative tools to accomplish the same goal. "
                f"DO NOT search the filesystem or look up the package source. Instead, tell the user: "
                f"'I hit the {mcp_server} {category} rate limit. Try again in {_fmt_duration(retry_after)}.' "
                f"Then END the task. This protects the connected account from anti-abuse bans."
            )
            logger.warning(f"[mcp-rate-limit] BLOCK {mcp_server}/{tool}: {cap}/{label} cap")
            return {"deny": reason, "retry_after_seconds": retry_after}

    state[state_key] = stamps + [now]
    _save_state(state)
    lo, hi = limits["jitter"]
    jitter = random.uniform(lo, hi) if hi > 0 else 0.0
    return {"allow": True, "jitter_s": jitter, "category": category}
