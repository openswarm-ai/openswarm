"""Provider registry. Anthropic via SDK; everything else via 9Router prefix routing.

The model-resolution gate: always go through here, never hardcode a model id.
Pricing/tier scoring lives in pricing.py, OpenRouter plumbing in openrouter.py,
thinking-level translation in thinking.py; all re-exported below so external
importers keep their single entry point.
"""

from __future__ import annotations

import logging
from typing import Any, TYPE_CHECKING

from .openrouter import (
    _OPENROUTER_VALUE_PREFIX,
    fetch_openrouter_models,
    get_direct_pricing,
    get_openrouter_pricing,
    invalidate_openrouter_cache,
)
from .pricing import (
    compute_billing_kind,
    compute_tiers,
    _heuristic_tiers,
)
from .thinking import thinking_params_for

if TYPE_CHECKING:
    from backend.apps.settings.models import AppSettings

logger = logging.getLogger(__name__)

# Full set of model-id prefixes that force routing through 9Router.
_NINEROUTER_MODEL_PREFIXES = ("cc/", "cx/", "gc/", "ag/", "gemini/", "openrouter/")

# Entry fields: value, label, context_window, model_id, router_model_id, api,
# subscription_only, reasoning, route ("cc"|"api"|"openrouter"|None).
# 9Router prefixes: cc/ Claude sub (dashes), cx/ Codex sub (dots), gc/ Gemini CLI.
BUILTIN_MODELS: dict[str, list[dict[str, Any]]] = {
    "Anthropic": [
        # Opus 4.7: SDK currently strips plaintext thinking deltas (encrypted only)
        # so the live "Thought for Ns" pill loses mid-turn text. Final answer + tokens fine.
        {"value": "opus-4-7", "label": "Claude Opus 4.7", "context_window": 1_000_000,
         "model_id": "claude-opus-4-7", "router_model_id": "cc/claude-opus-4-7", "api": "anthropic", "reasoning": True},
        {"value": "sonnet", "label": "Claude Sonnet 4.6", "context_window": 1_000_000,
         "model_id": "claude-sonnet-4-6", "router_model_id": "cc/claude-sonnet-4-6", "api": "anthropic", "reasoning": True},
        {"value": "opus", "label": "Claude Opus 4.6", "context_window": 1_000_000,
         "model_id": "claude-opus-4-6", "router_model_id": "cc/claude-opus-4-6", "api": "anthropic", "reasoning": True},
        {"value": "haiku", "label": "Claude Haiku 4.5", "context_window": 200_000,
         "model_id": "claude-haiku-4-5", "router_model_id": "cc/claude-haiku-4-5-20251001", "api": "anthropic", "reasoning": True},
        # cc/ pins the user's Claude sub regardless of connection_mode.
        {"value": "opus-4-7-cc", "label": "Claude Opus 4.7", "context_window": 1_000_000,
         "model_id": "claude-opus-4-7", "router_model_id": "cc/claude-opus-4-7", "api": "anthropic", "reasoning": True, "route": "cc"},
        {"value": "sonnet-cc", "label": "Claude Sonnet 4.6", "context_window": 1_000_000,
         "model_id": "claude-sonnet-4-6", "router_model_id": "cc/claude-sonnet-4-6", "api": "anthropic", "reasoning": True, "route": "cc"},
        {"value": "opus-cc", "label": "Claude Opus 4.6", "context_window": 1_000_000,
         "model_id": "claude-opus-4-6", "router_model_id": "cc/claude-opus-4-6", "api": "anthropic", "reasoning": True, "route": "cc"},
        {"value": "haiku-cc", "label": "Claude Haiku 4.5", "context_window": 200_000,
         "model_id": "claude-haiku-4-5", "router_model_id": "cc/claude-haiku-4-5-20251001", "api": "anthropic", "reasoning": True, "route": "cc"},

        {"value": "opus-4-7-api", "label": "Claude Opus 4.7 (API key)", "context_window": 1_000_000,
         "model_id": "claude-opus-4-7", "router_model_id": "claude-opus-4-7", "api": "anthropic", "reasoning": True, "route": "api"},
        {"value": "sonnet-api", "label": "Claude Sonnet 4.6 (API key)", "context_window": 1_000_000,
         "model_id": "claude-sonnet-4-6", "router_model_id": "claude-sonnet-4-6", "api": "anthropic", "reasoning": True, "route": "api"},
        {"value": "opus-api", "label": "Claude Opus 4.6 (API key)", "context_window": 1_000_000,
         "model_id": "claude-opus-4-6", "router_model_id": "claude-opus-4-6", "api": "anthropic", "reasoning": True, "route": "api"},
        {"value": "haiku-api", "label": "Claude Haiku 4.5 (API key)", "context_window": 200_000,
         "model_id": "claude-haiku-4-5", "router_model_id": "claude-haiku-4-5", "api": "anthropic", "reasoning": True, "route": "api"},
    ],

    "OpenAI": [
        # GPT-5.5 cx/ entry 404s on 9Router 0.3.60 (our pin); API-key route below works.
        {"value": "gpt-5.5", "label": "GPT-5.5",
         "context_window": 1_000_000, "router_model_id": "cx/gpt-5.5",
         "api": "codex", "subscription_only": True, "reasoning": True},
        {"value": "gpt-5.4", "label": "GPT-5.4",
         "context_window": 1_000_000, "router_model_id": "cx/gpt-5.4",
         "api": "codex", "subscription_only": True, "reasoning": True},
        {"value": "gpt-5.4-mini", "label": "GPT-5.4 Mini",
         "context_window": 400_000, "router_model_id": "cx/gpt-5.4-mini",
         "api": "codex", "subscription_only": True, "reasoning": True},
        # -high / -xhigh are distinct codex tunes (xhigh = max quality, slowest).
        {"value": "gpt-5.3-codex", "label": "GPT-5.3 Codex",
         "context_window": 400_000, "router_model_id": "cx/gpt-5.3-codex",
         "api": "codex", "subscription_only": True, "reasoning": True},
        {"value": "gpt-5.3-codex-high", "label": "GPT-5.3 Codex High",
         "context_window": 400_000, "router_model_id": "cx/gpt-5.3-codex-high",
         "api": "codex", "subscription_only": True, "reasoning": True},
        {"value": "gpt-5.3-codex-xhigh", "label": "GPT-5.3 Codex Extra High",
         "context_window": 400_000, "router_model_id": "cx/gpt-5.3-codex-xhigh",
         "api": "codex", "subscription_only": True, "reasoning": True},
        # API-key entries: route through 9Router's `cp-openai` provider-node
        # (registered by sync_openai_api_key) so 9Router's translator
        # dispatches to our local openai-passthrough proxy. The passthrough
        # renames `max_tokens` → `max_completion_tokens` before forwarding
        # to api.openai.com, fixing OpenAI's GPT-5 family 400. The bare
        # router_model_id (e.g. "gpt-5.5") still appears in the request
        # body; only the routing prefix changes.
        {"value": "gpt-5.5-api", "label": "GPT-5.5 (API key)",
         "context_window": 1_000_000, "router_model_id": "cp-openai/gpt-5.5", "model_id": "gpt-5.5",
         "api": "openai", "reasoning": True, "route": "api"},
        {"value": "gpt-5.4-api", "label": "GPT-5.4 (API key)",
         "context_window": 1_000_000, "router_model_id": "cp-openai/gpt-5.4", "model_id": "gpt-5.4",
         "api": "openai", "reasoning": True, "route": "api"},
        {"value": "gpt-5.4-mini-api", "label": "GPT-5.4 Mini (API key)",
         "context_window": 400_000, "router_model_id": "cp-openai/gpt-5.4-mini", "model_id": "gpt-5.4-mini",
         "api": "openai", "reasoning": True, "route": "api"},
        {"value": "gpt-5.3-codex-api", "label": "GPT-5.3 Codex (API key)",
         "context_window": 400_000, "router_model_id": "cp-openai/gpt-5.3-codex", "model_id": "gpt-5.3-codex",
         "api": "openai", "reasoning": True, "route": "api"},
        {"value": "gpt-5.3-codex-high-api", "label": "GPT-5.3 Codex High (API key)",
         "context_window": 400_000, "router_model_id": "cp-openai/gpt-5.3-codex-high", "model_id": "gpt-5.3-codex-high",
         "api": "openai", "reasoning": True, "route": "api"},
        {"value": "gpt-5.3-codex-xhigh-api", "label": "GPT-5.3 Codex Extra High (API key)",
         "context_window": 400_000, "router_model_id": "cp-openai/gpt-5.3-codex-xhigh", "model_id": "gpt-5.3-codex-xhigh",
         "api": "openai", "reasoning": True, "route": "api"},
    ],
    # Google: Gemini 3.x thoughtSignature continuity is bypassed via 9Router's
    # skip_thought_signature_validator (model can't build on prior reasoning,
    # but tools and thinking work). 3-pro / 3-flash route via Antigravity when
    # the AG OAuth lane is active; gc/ otherwise.
    "Google": [
        {"value": "gemini-3.1-pro", "label": "Gemini 3.1 Pro",
         "context_window": 1_000_000, "router_model_id": "gc/gemini-3.1-pro-preview",
         "api": "gemini-cli", "subscription_only": True, "reasoning": True},
        {"value": "gemini-3.1-flash-lite", "label": "Gemini 3.1 Flash Lite",
         "context_window": 1_000_000, "router_model_id": "gc/gemini-3.1-flash-lite-preview",
         "api": "gemini-cli", "subscription_only": True, "reasoning": True},
        {"value": "gemini-3-pro", "label": "Gemini 3 Pro",
         "context_window": 1_000_000, "router_model_id": "gc/gemini-3-pro-preview",
         "api": "gemini-cli", "subscription_only": True, "reasoning": True},
        {"value": "gemini-3-flash", "label": "Gemini 3 Flash",
         "context_window": 1_000_000, "router_model_id": "gc/gemini-3-flash-preview",
         "api": "gemini-cli", "subscription_only": True, "reasoning": True},
        # API-key entries: bypass 9Router, call generativelanguage.googleapis.com.
        {"value": "gemini-3.1-pro-api", "label": "Gemini 3.1 Pro (API key)",
         "context_window": 1_000_000, "router_model_id": "gemini-3.1-pro-preview", "model_id": "gemini-3.1-pro-preview",
         "api": "gemini", "reasoning": True, "route": "api"},
        {"value": "gemini-3.1-flash-lite-api", "label": "Gemini 3.1 Flash Lite (API key)",
         "context_window": 1_000_000, "router_model_id": "gemini-3.1-flash-lite-preview", "model_id": "gemini-3.1-flash-lite-preview",
         "api": "gemini", "reasoning": True, "route": "api"},
        {"value": "gemini-3-pro-api", "label": "Gemini 3 Pro (API key)",
         "context_window": 1_000_000, "router_model_id": "gemini-3-pro-preview", "model_id": "gemini-3-pro-preview",
         "api": "gemini", "reasoning": True, "route": "api"},
        {"value": "gemini-3-flash-api", "label": "Gemini 3 Flash (API key)",
         "context_window": 1_000_000, "router_model_id": "gemini-3-flash-preview", "model_id": "gemini-3-flash-preview",
         "api": "gemini", "reasoning": True, "route": "api"},
    ],
}


# ---------------------------------------------------------------------------
# Model resolution (used by the live claude_agent_sdk path)
# ---------------------------------------------------------------------------

_CUSTOM_VALUE_PREFIX = "custom/"


def _custom_provider_slug_for_lookup(name: str) -> str:
    """Mirror nine_router._custom_provider_slug; duplicated here to avoid
    importing from nine_router (circular: nine_router imports from settings)."""
    import re
    s = re.sub(r"[^a-zA-Z0-9-]+", "-", (name or "").strip().lower()).strip("-")
    return s or "custom"


def _find_custom_provider_for_value(settings, value: str):
    """Look up the CustomProvider whose slug matches the slug encoded in a
    `custom/<slug>/<model_id>` picker value. Returns None if no match."""
    if not isinstance(value, str) or not value.startswith(_CUSTOM_VALUE_PREFIX):
        return None
    rest = value[len(_CUSTOM_VALUE_PREFIX):]
    slug, _sep, _bare = rest.partition("/")
    if not slug:
        return None
    for cp in getattr(settings, "custom_providers", None) or []:
        if _custom_provider_slug_for_lookup(getattr(cp, "name", "")) == slug:
            return cp
    return None


def _find_builtin_model(short_name: str) -> dict | None:
    """Look up a model entry by its short `value`.

    OpenRouter entries (prefixed `or:<vendor>/<model>`) and custom-provider
    entries (prefixed `custom/<slug>/<model_id>`) aren't in BUILTIN_MODELS ,
    they're synthesised on demand so the rest of the routing code can treat
    them like BUILTIN_MODELS entries."""
    for models in BUILTIN_MODELS.values():
        for m in models:
            if m.get("value") == short_name:
                return m
    if isinstance(short_name, str) and short_name.startswith(_OPENROUTER_VALUE_PREFIX):
        bare = short_name[len(_OPENROUTER_VALUE_PREFIX):]
        if bare:
            return {
                "value": short_name,
                "label": bare,
                "context_window": 128_000,
                "model_id": bare,
                "router_model_id": f"openrouter/{bare}",
                "api": "openrouter",
                "route": "openrouter",
                "reasoning": False,
            }
    if isinstance(short_name, str) and short_name.startswith(_CUSTOM_VALUE_PREFIX):
        rest = short_name[len(_CUSTOM_VALUE_PREFIX):]
        slug, _sep, bare_model = rest.partition("/")
        if slug and bare_model:
            # Routing string `cp-<slug>/<model>` matches the prefix we use
            # when sync_custom_providers registers the provider node.
            routed = f"cp-{slug}/{bare_model}"
            return {
                "value": short_name,
                "label": bare_model,
                "context_window": 128_000,
                "model_id": routed,
                "router_model_id": routed,
                "api": "custom",
                "route": "api",
                "reasoning": False,
            }
    return None


def get_api_type(short_name: str) -> str:
    entry = _find_builtin_model(short_name)
    return (entry or {}).get("api", "anthropic")


def resolve_model_id_for_sdk(short_name: str, settings: AppSettings) -> str:
    """Short model name → id string for ClaudeAgentOptions."""
    entry = _find_builtin_model(short_name)
    if entry is None:
        return short_name
    if entry.get("route") == "cc":
        return entry.get("router_model_id", entry.get("model_id", short_name))
    if entry.get("route") == "api":
        return entry.get("model_id", short_name)
    if entry.get("route") == "openrouter":
        return entry.get("router_model_id", short_name)
    if entry.get("api") == "anthropic":
        if getattr(settings, "connection_mode", "own_key") == "openswarm-pro":
            return entry.get("model_id", short_name)
        if getattr(settings, "anthropic_api_key", None):
            return entry.get("model_id", short_name)
    # Gemini lane order: AI Studio apikey, Antigravity OAuth, Gemini CLI.
    # AG bypasses the thoughtSignature validator that breaks multi-step tool
    # turns on gc/. Without it, every Gemini turn 400s after the first tool
    # call with "Thought signature is not valid".
    _ANTIGRAVITY_MAP = {
        # gemini-3-pro-preview disabled: AG returns 404 even with active conn.
        # gemini-3.1-pro-preview disabled: AG's `gemini-3.1-pro-high` variant
        #   400s every request with "invalid argument" (the `-high` thinking-
        #   budget alias on AG requires a thinking_config the CLI doesn't
        #   emit). Falls through to gc/gemini-3.1-pro-preview, which works
        #   for non-tool turns; multi-step tool turns still hit the
        #   thoughtSignature validator but that's a separate fight.
        "gemini-3-flash-preview": "gemini-3-flash",
        "gemini-3.1-flash-lite-preview": "gemini-3-flash",
    }
    if entry.get("api") == "gemini-cli":
        rid = entry.get("router_model_id", "")
        if isinstance(rid, str) and rid.startswith("gc/"):
            suffix = rid[len("gc/"):]
            if getattr(settings, "google_api_key", None):
                return "gemini/" + suffix
            ag_suffix = _ANTIGRAVITY_MAP.get(suffix)
            if ag_suffix:
                try:
                    import httpx as _httpx
                    r = _httpx.get("http://localhost:20128/api/providers", timeout=2.0)
                    if r.status_code == 200:
                        data = r.json()
                        conns = data.get("connections", []) if isinstance(data, dict) else (data if isinstance(data, list) else [])
                        has_ag = any(
                            isinstance(c, dict)
                            and c.get("provider") == "antigravity"
                            and c.get("isActive")
                            for c in conns
                        )
                        if has_ag:
                            return "ag/" + ag_suffix
                except Exception:
                    pass
    return entry.get("router_model_id", entry.get("model_id", short_name))


async def resolve_aux_model(
    settings: AppSettings,
    preferred_tier: str = "haiku",
    primary_api: str | None = None,
) -> tuple[str, str | None]:
    """Pick the cheapest reachable model for one-shot aux LLM calls.

    primary_api lets the caller stay on the family the user is already
    paying for (Codex chat → Codex aux, OR chat → OR aux, etc.).
    Returns (model_id, base_url); base_url=None means default Anthropic.
    """
    haiku_bare = "claude-haiku-4-5-20251001"
    sonnet_bare = "claude-sonnet-4-20250514"
    or_haiku = "openrouter/anthropic/claude-haiku-4.5"
    or_sonnet = "openrouter/anthropic/claude-sonnet-4.5"
    bare = haiku_bare if preferred_tier == "haiku" else sonnet_bare
    or_aux = or_haiku if preferred_tier == "haiku" else or_sonnet

    from backend.apps.nine_router import is_running as _9r_running, get_providers as _9r_providers

    base_url = "http://localhost:20128"
    connected: set[str] = set()
    if _9r_running():
        try:
            connections = await _9r_providers()
            connected = {c.get("provider") for c in connections if c.get("isActive")}
        except Exception:
            connected = set()

    if primary_api == "codex":
        if "codex" in connected:
            return ("cx/gpt-5.4-mini", base_url)
        if getattr(settings, "openai_api_key", None):
            return ("gpt-5.4-mini", "https://api.openai.com/v1")
    elif primary_api == "gemini-cli" or primary_api == "gemini":
        if "gemini-cli" in connected:
            return ("gc/gemini-3.1-flash-lite-preview", base_url)
        if getattr(settings, "google_api_key", None):
            return ("gemini-3.1-flash-lite-preview", "https://generativelanguage.googleapis.com/v1beta")
    elif primary_api == "openrouter":
        if "openrouter" in connected:
            return (or_aux, base_url)

    if getattr(settings, "connection_mode", "own_key") == "openswarm-pro":
        proxy_url = getattr(settings, "openswarm_proxy_url", None) or "https://api.openswarm.com"
        return (bare, proxy_url)

    if getattr(settings, "anthropic_api_key", None):
        return (bare, None)

    if not _9r_running():
        raise ValueError(
            "No AI provider configured for auxiliary LLM call. "
            "Set an Anthropic API key or connect a subscription."
        )

    if "claude" in connected:
        return (f"cc/{haiku_bare}" if preferred_tier == "haiku" else f"cc/{sonnet_bare}", base_url)
    if "codex" in connected:
        return ("cx/gpt-5.4-mini", base_url)
    if "gemini-cli" in connected:
        return ("gc/gemini-3.1-flash-lite-preview", base_url)
    # OR is metered, hence last; saves OR-only users from "Untitled session" hell.
    if "openrouter" in connected:
        return (or_aux, base_url)

    raise ValueError(
        "No AI provider connected for auxiliary LLM call. "
        "Connect at least one subscription in Settings."
    )


def get_context_window(provider: str, model: str, settings: AppSettings | None = None) -> int:
    """Look up context window for any model."""
    # Check built-in models first
    for models in BUILTIN_MODELS.values():
        for m in models:
            if m["value"] == model:
                return m.get("context_window", 128_000)

    # Check custom providers; picker values are `custom/<slug>/<bare_model>`;
    # cp.models[].value stores the bare model id the user typed. Match the
    # bare-model tail against any custom provider's models list.
    if settings:
        bare_model = model
        if isinstance(model, str) and model.startswith(_CUSTOM_VALUE_PREFIX):
            rest = model[len(_CUSTOM_VALUE_PREFIX):]
            _slug, _sep, bare_model = rest.partition("/")
        for cp in getattr(settings, "custom_providers", []):
            for m in (getattr(cp, "models", None) or []):
                if m.get("value") == bare_model or m.get("id") == bare_model:
                    cw = m.get("context_window")
                    if isinstance(cw, int) and cw > 0:
                        return cw

    return 128_000  # safe default


# ---------------------------------------------------------------------------
# Cost tracking
# ---------------------------------------------------------------------------

COST_PER_1M_TOKENS: dict[tuple[str, str], tuple[float, float]] = {
    # (provider, model): (input_cost_per_1M, output_cost_per_1M)
    # NOTE: real cost numbers come from 9Router's usage stats. These entries
    # are kept so the table matches BUILTIN_MODELS and can
    # be used by any future native-loop path. Subscription-routed models
    # are zero-cost to the user, but API rates are recorded here for
    # reference where they exist.
    # Anthropic (direct API rates).
    ("Anthropic", "sonnet"): (3.0, 15.0),
    ("Anthropic", "opus"): (5.0, 25.0),
    ("Anthropic", "opus-4-7"): (5.0, 25.0),
    ("Anthropic", "haiku"): (1.0, 5.0),
    # OpenAI; Codex subscription path, user pays nothing per token
    ("OpenAI", "gpt-5.5"): (0.0, 0.0),
    ("OpenAI", "gpt-5.4"): (0.0, 0.0),
    ("OpenAI", "gpt-5.4-mini"): (0.0, 0.0),
    ("OpenAI", "gpt-5.3-codex"): (0.0, 0.0),
    ("OpenAI", "gpt-5.3-codex-high"): (0.0, 0.0),
    ("OpenAI", "gpt-5.3-codex-xhigh"): (0.0, 0.0),
    # Google; Gemini CLI subscription path, user pays nothing per token
    ("Google", "gemini-3.1-pro"): (0.0, 0.0),
    ("Google", "gemini-3.1-flash-lite"): (0.0, 0.0),
    ("Google", "gemini-3-pro"): (0.0, 0.0),
    ("Google", "gemini-3-flash"): (0.0, 0.0),
    ("Google", "gemini-2.5-pro"): (0.0, 0.0),
    ("Google", "gemini-2.5-flash"): (0.0, 0.0),
    # OpenRouter-backed (approximate)
    ("xAI", "x-ai/grok-4-0214"): (3.0, 15.0),
    ("Meta", "meta-llama/llama-4-maverick"): (0.50, 0.70),
    ("Meta", "meta-llama/llama-4-scout"): (0.15, 0.40),
    ("DeepSeek", "deepseek/deepseek-chat-v3-0324"): (0.30, 0.90),
    ("DeepSeek", "deepseek/deepseek-r1"): (0.80, 2.40),
    ("Mistral", "mistralai/mistral-large-2501"): (2.0, 6.0),
    ("Mistral", "mistralai/mistral-small-3.1-24b-instruct"): (0.10, 0.30),
    ("Qwen", "qwen/qwen3-coder"): (0.0, 0.0),
    ("Qwen", "qwen/qwen3-235b-a22b"): (0.20, 0.70),
    ("Cohere", "cohere/command-a-03-2025"): (2.50, 10.0),
}
