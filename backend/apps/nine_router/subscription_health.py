"""Boot-time subscription health probe: catches a provider login that died while the app was
closed (refresh-token rotation, the "Breaking codex" class) so the UI can offer reconnect BEFORE
the user burns a failed turn discovering it. Probes SUBSCRIPTION lanes only (1 token of sub quota,
never a billable API key), and only a definitive auth-shaped 401/403 counts as dead: transient
429/5xx/timeouts stay silent so the pill can never cry wolf. Kill switch: OPENSWARM_BOOT_HEALTH=0."""

import asyncio
import logging
import os
import time
from typing import Dict, List, Optional

import httpx
from typeguard import typechecked

from backend.apps.nine_router.process import NINE_ROUTER_URL, is_running

logger = logging.getLogger(__name__)

PREFIX_BY_PROVIDER: Dict[str, str] = {
    "claude": "cc/",
    "codex": "cx/",
    "gemini-cli": "gemini/",
    "antigravity": "ag/",
}
LABEL_BY_PROVIDER: Dict[str, str] = {
    "claude": "Claude",
    "codex": "ChatGPT",
    "gemini-cli": "Gemini",
    "antigravity": "Gemini (Antigravity)",
}
P_AUTH_DEAD_MARKERS = ("authentication", "expired", "sign in", "signing in", "invalid_grant", "unauthorized", "invalid authentication")
P_PROBE_TIMEOUT_S = 25.0
P_CACHE_TTL_S = 300.0

p_probe_lock = asyncio.Lock()
p_cached_result: Optional[List[Dict[str, str]]] = None
p_cached_at: float = 0.0


@typechecked
def health_probe_enabled() -> bool:
    return os.environ.get("OPENSWARM_BOOT_HEALTH", "1") != "0"


@typechecked
def classify_auth_dead(status_code: int, body_text: str) -> bool:
    """Dead ONLY on a definitive auth failure; anything ambiguous reads healthy (silence beats a false reconnect prompt)."""
    if status_code not in (401, 403):
        return False
    low = body_text.lower()
    return any(m in low for m in P_AUTH_DEAD_MARKERS)


@typechecked
async def p_pick_probe_model(client: httpx.AsyncClient, prefix: str) -> Optional[str]:
    try:
        r = await client.get(f"{NINE_ROUTER_URL}/v1/models")
        if r.status_code != 200:
            return None
        ids = [m.get("id") for m in (r.json().get("data") or []) if isinstance(m, dict)]
        for i in ids:
            if isinstance(i, str) and i.startswith(prefix):
                return i
    except Exception:
        return None
    return None


@typechecked
async def p_probe_one(client: httpx.AsyncClient, model: str) -> Optional[bool]:
    """True = auth dead, False = healthy, None = inconclusive (never reported)."""
    try:
        r = await client.post(
            f"{NINE_ROUTER_URL}/v1/messages",
            json={"model": model, "max_tokens": 1, "messages": [{"role": "user", "content": "hi"}]},
            headers={"x-api-key": "9router", "anthropic-version": "2023-06-01"},
        )
        if r.status_code < 400:
            return False
        return True if classify_auth_dead(r.status_code, r.text or "") else None
    except Exception:
        return None


@typechecked
async def probe_subscription_health(connections: List[Dict]) -> List[Dict[str, str]]:
    """Probe each active subscription connection with a 1-token turn; returns [{provider, label}]
    for the definitively auth-dead ones. Cached for 5 minutes; concurrent callers share one run."""
    global p_cached_result, p_cached_at
    if not health_probe_enabled() or not is_running():
        return []
    async with p_probe_lock:
        if p_cached_result is not None and time.monotonic() - p_cached_at < P_CACHE_TTL_S:
            return p_cached_result
        subs = [
            c for c in connections
            if isinstance(c, dict) and c.get("provider") in PREFIX_BY_PROVIDER and c.get("isActive")
        ]
        dead: List[Dict[str, str]] = []
        if subs:
            async with httpx.AsyncClient(timeout=P_PROBE_TIMEOUT_S) as client:
                for c in subs:
                    provider = str(c.get("provider"))
                    model = await p_pick_probe_model(client, PREFIX_BY_PROVIDER[provider])
                    if not model:
                        continue
                    verdict = await p_probe_one(client, model)
                    if verdict is True:
                        dead.append({"provider": provider, "label": LABEL_BY_PROVIDER[provider]})
                        logger.info(f"[sub-health] {provider}: auth dead (reconnect needed)")
        p_cached_result = dead
        p_cached_at = time.monotonic()
        return dead
