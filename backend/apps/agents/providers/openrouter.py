"""OpenRouter + 9Router pricing/catalog plumbing. Caches, pricing tables, model fetch."""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"

# `or:` prefix on picker values so resolve_model_id_for_sdk recognises them
# without a side-table.
_OPENROUTER_VALUE_PREFIX = "or:"

_OR_MODELS_TTL_OK = 3600.0
_OR_MODELS_TTL_FAIL = 30.0
_or_models_cache: dict = {"models": None, "fetched_at": 0.0, "ok": False}

_9router_cache: dict = {"available": None, "checked_at": 0}


# Per-model published pricing in $/1M tokens (input, output) for direct
# API key lanes. Sourced from each provider's official pricing page as of
# May 2026. The Claude Agent SDK ALWAYS computes total_cost_usd at
# Anthropic rates; for any non-Anthropic upstream the SDK number is
# 50-1000x wrong and we MUST recompute. Used by agent_manager's cost
# recompute logic.
_DIRECT_API_PRICING: dict[str, tuple[float, float]] = {
    # OpenAI GPT-5.x family (source: platform.openai.com/docs/pricing).
    "gpt-5.5":             (1.25, 10.00),
    "gpt-5.4":             (1.25, 10.00),
    "gpt-5.4-mini":        (0.25,  2.00),
    "gpt-5.3-codex":       (1.25, 10.00),
    "gpt-5.3-codex-high":  (1.25, 10.00),
    "gpt-5.3-codex-xhigh": (1.25, 10.00),
    # Google Gemini direct API (ai.google.dev/pricing).
    "gemini-3.1-pro-preview":        (1.25, 10.00),
    "gemini-3.1-flash-lite-preview": (0.10,  0.40),
    "gemini-3-pro-preview":          (1.25, 10.00),
    "gemini-3-flash-preview":        (0.30,  2.50),
}


def get_direct_pricing(model_id: str) -> tuple[float, float] | None:
    """($/1M input, $/1M output) for an OpenAI or Gemini direct-API model_id.
    Returns None for any model not in the pricing table; callers fall back
    to the SDK's (Anthropic-rate) estimate which is wrong but at least
    deterministic."""
    if not isinstance(model_id, str):
        return None
    bare = model_id
    for prefix in ("cp-openai/", "cp-gemini/", "cp-google/", "openai/", "google/", "gemini/"):
        if bare.startswith(prefix):
            bare = bare[len(prefix):]
            break
    return _DIRECT_API_PRICING.get(bare)


def get_openrouter_pricing(resolved_model: str) -> tuple[float, float] | None:
    """($/1M input, $/1M output) for an openrouter/ id, or None if not cached."""
    if not isinstance(resolved_model, str) or not resolved_model.startswith("openrouter/"):
        return None
    bare = resolved_model[len("openrouter/"):]
    for m in _or_models_cache.get("models") or []:
        if m.get("model_id") == bare:
            return (
                float(m.get("input_cost_per_1m", 0.0)),
                float(m.get("output_cost_per_1m", 0.0)),
            )
    return None


def invalidate_openrouter_cache() -> None:
    _or_models_cache["models"] = None
    _or_models_cache["fetched_at"] = 0.0
    _or_models_cache["ok"] = False


async def fetch_openrouter_models(api_key: str | None) -> list[dict]:
    """Return OR's tool-capable chat catalog. Cached. Never raises."""
    import time as _time
    if not api_key:
        invalidate_openrouter_cache()
        return []

    now = _time.monotonic()
    fetched_at = _or_models_cache["fetched_at"]
    if _or_models_cache["models"] is not None:
        ttl = _OR_MODELS_TTL_OK if _or_models_cache["ok"] else _OR_MODELS_TTL_FAIL
        if now - fetched_at < ttl:
            return _or_models_cache["models"]

    import httpx
    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            r = await client.get(
                f"{OPENROUTER_BASE_URL}/models",
                headers={"Authorization": f"Bearer {api_key}"},
            )
        if r.status_code != 200:
            _or_models_cache.update(models=[], fetched_at=now, ok=False)
            logger.debug(f"OpenRouter /models returned {r.status_code}")
            return []
        raw = r.json().get("data") or []
    except Exception as e:
        _or_models_cache.update(models=[], fetched_at=now, ok=False)
        logger.debug(f"OpenRouter /models fetch failed: {e}")
        return []

    out: list[dict] = []
    for m in raw:
        if not isinstance(m, dict):
            continue
        model_id = m.get("id") or ""
        if not model_id or "/" not in model_id:
            continue
        arch = m.get("architecture") or {}
        in_mods = arch.get("input_modalities") or []
        out_mods = arch.get("output_modalities") or []
        if isinstance(in_mods, list) and in_mods and "text" not in in_mods:
            continue
        if isinstance(out_mods, list) and out_mods and "text" not in out_mods:
            continue
        # Tools required; agent loop doesn't work without function calling.
        params = m.get("supported_parameters") or []
        if not isinstance(params, list) or "tools" not in params:
            continue
        ctx = m.get("context_length") or 128_000
        try:
            ctx = int(ctx)
        except (TypeError, ValueError):
            ctx = 128_000
        reasoning_capable = bool("reasoning" in params or "include_reasoning" in params)
        vendor = model_id.split("/", 1)[0]
        label = m.get("name") or model_id
        pricing = m.get("pricing") or {}
        try:
            prompt_per_tok = float(pricing.get("prompt") or 0)
            completion_per_tok = float(pricing.get("completion") or 0)
        except (TypeError, ValueError):
            prompt_per_tok = completion_per_tok = 0.0
        # Negative price = OR's "varies" sentinel (e.g. openrouter/auto). Clamp.
        is_variable_pricing = prompt_per_tok < 0 or completion_per_tok < 0
        if is_variable_pricing:
            prompt_per_tok = 0.0
            completion_per_tok = 0.0
        is_free = (
            not is_variable_pricing
            and prompt_per_tok == 0.0 and completion_per_tok == 0.0
        )
        top_provider = m.get("top_provider") or {}
        max_completion = top_provider.get("max_completion_tokens")
        try:
            max_completion = int(max_completion) if max_completion else None
        except (TypeError, ValueError):
            max_completion = None
        out.append({
            "value": f"{_OPENROUTER_VALUE_PREFIX}{model_id}",
            "label": label,
            "context_window": ctx,
            "model_id": model_id,
            "router_model_id": f"openrouter/{model_id}",
            "api": "openrouter",
            "route": "openrouter",
            "reasoning": reasoning_capable,
            "vendor": vendor,
            "input_cost_per_1m": prompt_per_tok * 1_000_000,
            "output_cost_per_1m": completion_per_tok * 1_000_000,
            "is_free": is_free,
            "max_completion_tokens": max_completion,
        })

    _or_models_cache.update(models=out, fetched_at=now, ok=True)
    return out
