"""Provider registry. Anthropic via SDK; everything else via 9Router prefix routing.

The model-resolution gate: always go through here, never hardcode a model id.
Pricing/tier scoring lives in pricing.py, OpenRouter plumbing in openrouter.py,
thinking-level translation in thinking_params_for.py; all re-exported below so external
importers keep their single entry point.
"""

from __future__ import annotations

import logging
from typing import Any, TYPE_CHECKING

from backend.apps.agents.providers.openrouter import (
    OPENROUTER_VALUE_PREFIX,
    fetch_openrouter_models,
    get_direct_pricing,
    get_openrouter_pricing,
    invalidate_openrouter_cache,
)
from backend.apps.agents.providers.pricing import (
    compute_billing_kind,
    compute_tiers,
    heuristic_tiers,
)
from backend.apps.agents.providers.thinking_params_for import thinking_params_for

if TYPE_CHECKING:
    from backend.apps.settings.models import AppSettings

logger = logging.getLogger(__name__)

# Full set of model-id prefixes that force routing through 9Router.
NINEROUTER_MODEL_PREFIXES = ("cc/", "cx/", "gc/", "ag/", "gemini/", "openrouter/")

# Entry fields: value, label, context_window, model_id, router_model_id, api, subscription_only, reasoning, route ("cc"|"api"|"openrouter"|None). 9Router prefixes: cc/ Claude sub (dashes), cx/ Codex sub (dots), gc/ Gemini CLI.
BUILTIN_MODELS: dict[str, list[dict[str, Any]]] = {
    "Anthropic": [
        # Opus 4.8 (released 2026-05-28): Anthropic's flagship, recommended for the most complex work. Adaptive thinking (not extended), effort param defaults to high. 1M ctx, 128k max output, $5/$25. Verified live on the cc sub route (this app runs on it) and the API.
        {"value": "opus-4-8", "label": "Claude Opus 4.8", "context_window": 1_000_000,
         "model_id": "claude-opus-4-8", "router_model_id": "cc/claude-opus-4-8", "api": "anthropic", "reasoning": True},
        # Opus 4.7: SDK currently strips plaintext thinking deltas (encrypted only) so the live "Thought for Ns" pill loses mid-turn text. Final answer + tokens fine.
        {"value": "opus-4-7", "label": "Claude Opus 4.7", "context_window": 1_000_000,
         "model_id": "claude-opus-4-7", "router_model_id": "cc/claude-opus-4-7", "api": "anthropic", "reasoning": True},
        # Sonnet 5 (2026-06-30): cheaper near-Opus-4.8 agentic model. cc/ route assumed to pass through like opus-4-8 did; needs a live sub-route check.
        {"value": "sonnet-5", "label": "Claude Sonnet 5", "context_window": 1_000_000,
         "model_id": "claude-sonnet-5", "router_model_id": "cc/claude-sonnet-5", "api": "anthropic", "reasoning": True},
        {"value": "sonnet", "label": "Claude Sonnet 4.6", "context_window": 1_000_000,
         "model_id": "claude-sonnet-4-6", "router_model_id": "cc/claude-sonnet-4-6", "api": "anthropic", "reasoning": True},
        {"value": "opus", "label": "Claude Opus 4.6", "context_window": 1_000_000,
         "model_id": "claude-opus-4-6", "router_model_id": "cc/claude-opus-4-6", "api": "anthropic", "reasoning": True},
        {"value": "haiku", "label": "Claude Haiku 4.5", "context_window": 200_000,
         "model_id": "claude-haiku-4-5", "router_model_id": "cc/claude-haiku-4-5-20251001", "api": "anthropic", "reasoning": True},
        # cc/ pins the user's Claude sub regardless of connection_mode.
        {"value": "opus-4-8-cc", "label": "Claude Opus 4.8", "context_window": 1_000_000,
         "model_id": "claude-opus-4-8", "router_model_id": "cc/claude-opus-4-8", "api": "anthropic", "reasoning": True, "route": "cc"},
        {"value": "opus-4-7-cc", "label": "Claude Opus 4.7", "context_window": 1_000_000,
         "model_id": "claude-opus-4-7", "router_model_id": "cc/claude-opus-4-7", "api": "anthropic", "reasoning": True, "route": "cc"},
        {"value": "sonnet-5-cc", "label": "Claude Sonnet 5", "context_window": 1_000_000,
         "model_id": "claude-sonnet-5", "router_model_id": "cc/claude-sonnet-5", "api": "anthropic", "reasoning": True, "route": "cc"},
        {"value": "sonnet-cc", "label": "Claude Sonnet 4.6", "context_window": 1_000_000,
         "model_id": "claude-sonnet-4-6", "router_model_id": "cc/claude-sonnet-4-6", "api": "anthropic", "reasoning": True, "route": "cc"},
        {"value": "opus-cc", "label": "Claude Opus 4.6", "context_window": 1_000_000,
         "model_id": "claude-opus-4-6", "router_model_id": "cc/claude-opus-4-6", "api": "anthropic", "reasoning": True, "route": "cc"},
        {"value": "haiku-cc", "label": "Claude Haiku 4.5", "context_window": 200_000,
         "model_id": "claude-haiku-4-5", "router_model_id": "cc/claude-haiku-4-5-20251001", "api": "anthropic", "reasoning": True, "route": "cc"},

        # Fable 5 re-added 2026-07-02 after the ban lifted (Eric confirmed access is back); pull both rows again if it errors live.
        {"value": "fable-5-cc", "label": "Claude Fable 5", "context_window": 1_000_000,
         "model_id": "claude-fable-5", "router_model_id": "cc/claude-fable-5", "api": "anthropic", "reasoning": True, "route": "cc"},
        {"value": "fable-5-api", "label": "Claude Fable 5 (API key)", "context_window": 1_000_000,
         "model_id": "claude-fable-5", "router_model_id": "claude-fable-5", "api": "anthropic", "reasoning": True, "route": "api"},
        {"value": "opus-4-8-api", "label": "Claude Opus 4.8 (API key)", "context_window": 1_000_000,
         "model_id": "claude-opus-4-8", "router_model_id": "claude-opus-4-8", "api": "anthropic", "reasoning": True, "route": "api"},
        {"value": "opus-4-7-api", "label": "Claude Opus 4.7 (API key)", "context_window": 1_000_000,
         "model_id": "claude-opus-4-7", "router_model_id": "claude-opus-4-7", "api": "anthropic", "reasoning": True, "route": "api"},
        {"value": "sonnet-5-api", "label": "Claude Sonnet 5 (API key)", "context_window": 1_000_000,
         "model_id": "claude-sonnet-5", "router_model_id": "claude-sonnet-5", "api": "anthropic", "reasoning": True, "route": "api"},
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
        # gpt-5.3-codex (+ high/xhigh) removed: superseded by GPT-5.5 as OpenAI's recommended Codex model, and high/xhigh were never separate models (just reasoning-effort variants), so they were redundant clutter. API-key entries: route through 9Router's `cp-openai` provider-node (registered by sync_openai_api_key) so 9Router's translator dispatches to our local openai-passthrough proxy. The passthrough renames `max_tokens` → `max_completion_tokens` before forwarding to api.openai.com, fixing OpenAI's GPT-5 family 400. The bare router_model_id (e.g. "gpt-5.5") still appears in the request body; only the routing prefix changes.
        {"value": "gpt-5.5-api", "label": "GPT-5.5 (API key)",
         "context_window": 1_000_000, "router_model_id": "cp-openai/gpt-5.5", "model_id": "gpt-5.5",
         "api": "openai", "reasoning": True, "route": "api"},
        {"value": "gpt-5.4-api", "label": "GPT-5.4 (API key)",
         "context_window": 1_000_000, "router_model_id": "cp-openai/gpt-5.4", "model_id": "gpt-5.4",
         "api": "openai", "reasoning": True, "route": "api"},
        {"value": "gpt-5.4-mini-api", "label": "GPT-5.4 Mini (API key)",
         "context_window": 400_000, "router_model_id": "cp-openai/gpt-5.4-mini", "model_id": "gpt-5.4-mini",
         "api": "openai", "reasoning": True, "route": "api"},
    ],
    # Google: Gemini 3.x thoughtSignature continuity is bypassed via 9Router's skip_thought_signature_validator (model can't build on prior reasoning, but tools and thinking work). 3-pro / 3-flash route via Antigravity when the AG OAuth lane is active; gc/ otherwise.
    "Google": [
        # Gemini 3.5 Flash (GA 2026-05-19) is offered on the API-key route ONLY (see the api entry below). Its gc/ subscription entry was pulled because the pinned 9Router 0.3.60 registry has no gemini-3.5-flash and the gc/ route allowlists (every other shipped Gemini sub model IS in 0.3.60), so gc/ gemini-3.5-flash would 404. Re-add the gc/ entry once 9Router is bumped past 0.3.60 (gated by the WebSearch-translation regression; see CLAUDE.md). gemini-3.1-pro pulled (both sub + api-key rows): Antigravity can't serve it (its -high variant 400s) and the AI Studio key 429s pro-preview hard, so it had no working lane and only sold a dead option.
        {"value": "gemini-3.1-flash-lite", "label": "Gemini 3.1 Flash Lite",
         "context_window": 1_000_000, "router_model_id": "gc/gemini-3.1-flash-lite-preview",
         "api": "gemini-cli", "subscription_only": True, "reasoning": True},
        # gemini-3-pro removed 2026-03-09 and gemini-3-flash removed 2026-07-03 (both rows, independently on two branches): gemini-3-flash-preview aged out upstream (API-key lane hangs/429s with no fail-fast, measured 7-21s; only an Antigravity sub masked it). 3.5-flash / 3.1-flash-lite cover the slots; ag/gemini-3-flash lives on as an aux model, not a picker row.
        # API-key entries: bypass 9Router, call generativelanguage.googleapis.com.
        {"value": "gemini-3.5-flash-api", "label": "Gemini 3.5 Flash (API key)",
         "context_window": 1_000_000, "router_model_id": "gemini-3.5-flash", "model_id": "gemini-3.5-flash",
         "api": "gemini", "reasoning": True, "route": "api"},
        {"value": "gemini-3.1-flash-lite-api", "label": "Gemini 3.1 Flash Lite (API key)",
         "context_window": 1_000_000, "router_model_id": "gemini-3.1-flash-lite-preview", "model_id": "gemini-3.1-flash-lite-preview",
         "api": "gemini", "reasoning": True, "route": "api"},
    ],
}


# --------------------------------------------------------------------------- Model resolution (used by the live claude_agent_sdk path) ---------------------------------------------------------------------------

CUSTOM_VALUE_PREFIX = "custom/"


def custom_provider_slug_for_lookup(name: str) -> str:
    """Mirror nine_router._custom_provider_slug; duplicated here to avoid
    importing from nine_router (circular: nine_router imports from settings)."""
    import re
    s = re.sub(r"[^a-zA-Z0-9-]+", "-", (name or "").strip().lower()).strip("-")
    return s or "custom"


def find_custom_provider_for_value(settings, value: str):
    """Look up the CustomProvider whose slug matches the slug encoded in a
    `custom/<slug>/<model_id>` picker value. Returns None if no match."""
    if not isinstance(value, str) or not value.startswith(CUSTOM_VALUE_PREFIX):
        return None
    rest = value[len(CUSTOM_VALUE_PREFIX):]
    slug, p_sep, p_bare = rest.partition("/")
    if not slug:
        return None
    for cp in getattr(settings, "custom_providers", None) or []:
        if custom_provider_slug_for_lookup(getattr(cp, "name", "")) == slug:
            return cp
    return None


def find_builtin_model(short_name: str) -> dict | None:
    """Look up a model entry by its short `value`.

    OpenRouter entries (prefixed `or:<vendor>/<model>`) and custom-provider
    entries (prefixed `custom/<slug>/<model_id>`) aren't in BUILTIN_MODELS ,
    they're synthesised on demand so the rest of the routing code can treat
    them like BUILTIN_MODELS entries."""
    for models in BUILTIN_MODELS.values():
        for m in models:
            if m.get("value") == short_name:
                return m
    if isinstance(short_name, str) and short_name.startswith(OPENROUTER_VALUE_PREFIX):
        bare = short_name[len(OPENROUTER_VALUE_PREFIX):]
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
    if isinstance(short_name, str) and short_name.startswith(CUSTOM_VALUE_PREFIX):
        rest = short_name[len(CUSTOM_VALUE_PREFIX):]
        slug, p_sep, bare_model = rest.partition("/")
        if slug and bare_model:
            # Routing string `cp-<slug>/<model>` matches the prefix we use when sync_custom_providers registers the provider node.
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
    entry = find_builtin_model(short_name)
    return (entry or {}).get("api", "anthropic")


def p_antigravity_connected() -> bool:
    """True if a live Antigravity OAuth lane exists in 9Router. Synchronous
    probe (this resolver is sync) with a tight timeout; any hiccup reads as
    'no' so a slow/absent 9Router never blocks model resolution for long."""
    try:
        import httpx as p_httpx
        from backend.apps.nine_router.process import cli_auth_headers
        r = p_httpx.get("http://localhost:20128/api/providers", timeout=2.0, headers=cli_auth_headers())
        if r.status_code != 200:
            return False
        data = r.json()
        conns = data.get("connections", []) if isinstance(data, dict) else (data if isinstance(data, list) else [])
        return any(
            isinstance(c, dict) and c.get("provider") == "antigravity" and c.get("isActive")
            for c in conns
        )
    except Exception:
        return False


def resolve_model_id_for_sdk(short_name: str, settings: AppSettings) -> str:
    """Short model name → id string for ClaudeAgentOptions."""
    # Free trial funds only Haiku via the cloud proxy; force it so a session left on a gpt-*/sub model can't escape to a lane the trial can't fund (which snags as a 401/404).
    if getattr(settings, "connection_mode", "own_key") == "free-trial":
        short_name = "haiku"
    entry = find_builtin_model(short_name)
    if entry is None:
        return short_name
    if entry.get("route") == "cc":
        return entry.get("router_model_id", entry.get("model_id", short_name))
    if entry.get("route") == "api":
        # OpenAI own-key still rides 9Router (the cp-openai node fixes max_tokens + translates Anthropic->OpenAI), so it MUST keep its cp-openai/ routing prefix or 9Router has no node to dispatch to. Anthropic own-key goes straight to api.anthropic.com and Gemini own-key via the local proxy, both on the bare id.
        if entry.get("api") == "openai":
            return entry.get("router_model_id", entry.get("model_id", short_name))
        return entry.get("model_id", short_name)
    if entry.get("route") == "openrouter":
        return entry.get("router_model_id", short_name)
    if entry.get("api") == "anthropic":
        # openswarm-pro AND free-trial both proxy-route, so resolve to the bare id (the proxy serves it) instead of the cc/-prefixed id that 401s when no Claude subscription is connected. This is the line that otherwise turns a free-trial user's first run into "No AI provider connected".
        if getattr(settings, "connection_mode", "own_key") in ("openswarm-pro", "free-trial"):
            return entry.get("model_id", short_name)
        if getattr(settings, "anthropic_api_key", None):
            return entry.get("model_id", short_name)
    # Gemini lane order: Antigravity OAuth (for the models it serves), then AI Studio apikey, then Gemini CLI. AG bypasses the thoughtSignature validator that breaks multi-step Gemini turns AND supports real reasoning, so a connected AG sub is preferred over the AI Studio key, which otherwise silently shadowed it. The map is AG's allowlist; pro variants 404/400 on AG and are deliberately absent, so they fall through to the key.
    P_ANTIGRAVITY_MAP = {
        # gemini-3-pro-preview disabled: AG returns 404 even with active conn. gemini-3.1-pro-preview disabled: AG's `gemini-3.1-pro-high` variant 400s every request with "invalid argument" (the `-high` thinking- budget alias on AG requires a thinking_config the CLI doesn't emit). Falls through to the AI Studio key / gc/ instead. gemini-3-flash-preview key dropped with its registry entry (aged out upstream).
        "gemini-3.1-flash-lite-preview": "gemini-3-flash",  # 3.1-flash-lite has no AG variant, so AG serves it via gemini-3-flash
    }
    if entry.get("api") == "gemini-cli":
        rid = entry.get("router_model_id", "")
        if isinstance(rid, str) and rid.startswith("gc/"):
            suffix = rid[len("gc/"):]
            ag_suffix = P_ANTIGRAVITY_MAP.get(suffix)
            if ag_suffix and p_antigravity_connected():
                return "ag/" + ag_suffix
            if getattr(settings, "google_api_key", None):
                return "gemini/" + suffix
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
    # Must track the canonical Anthropic entries in BUILTIN_MODELS (sonnet/haiku); a stale id here 404s every aux call (sonnet was pinned to the long-dead 4.0 "20250514" and silently broke).
    haiku_bare = "claude-haiku-4-5-20251001"
    sonnet_bare = "claude-sonnet-4-6"
    or_haiku = "openrouter/anthropic/claude-haiku-4.5"
    or_sonnet = "openrouter/anthropic/claude-sonnet-4.5"
    bare = haiku_bare if preferred_tier == "haiku" else sonnet_bare
    or_aux = or_haiku if preferred_tier == "haiku" else or_sonnet

    from backend.apps.nine_router import is_running as p_9r_running, get_providers as p_9r_providers

    base_url = "http://localhost:20128"
    connected: set[str] = set()
    if p_9r_running():
        try:
            connections = await p_9r_providers()
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

    if getattr(settings, "connection_mode", "own_key") in ("openswarm-pro", "free-trial"):
        from backend.apps.settings.credentials import proxy_auth
        token, base = proxy_auth(settings)
        if token:
            return (bare, base)

    if getattr(settings, "anthropic_api_key", None):
        return (bare, None)

    if not p_9r_running():
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

    # Check custom providers; picker values are `custom/<slug>/<bare_model>`; cp.models[].value stores the bare model id the user typed. Match the bare-model tail against any custom provider's models list.
    if settings:
        bare_model = model
        if isinstance(model, str) and model.startswith(CUSTOM_VALUE_PREFIX):
            rest = model[len(CUSTOM_VALUE_PREFIX):]
            p_slug, p_sep, bare_model = rest.partition("/")
        for cp in getattr(settings, "custom_providers", []):
            for m in (getattr(cp, "models", None) or []):
                if m.get("value") == bare_model or m.get("id") == bare_model:
                    cw = m.get("context_window")
                    if isinstance(cw, int) and cw > 0:
                        return cw

    return 128_000  # safe default


# --------------------------------------------------------------------------- Cost tracking ---------------------------------------------------------------------------

COST_PER_1M_TOKENS: dict[tuple[str, str], tuple[float, float]] = {
    # (provider, model): (input_cost_per_1M, output_cost_per_1M) NOTE: real cost numbers come from 9Router's usage stats. These entries are kept so the table matches BUILTIN_MODELS and can be used by any future native-loop path. Subscription-routed models are zero-cost to the user, but API rates are recorded here for reference where they exist. Anthropic (direct API rates).
    ("Anthropic", "sonnet"): (3.0, 15.0),
    ("Anthropic", "sonnet-5"): (3.0, 15.0),
    ("Anthropic", "opus"): (5.0, 25.0),
    ("Anthropic", "opus-4-7"): (5.0, 25.0),
    ("Anthropic", "opus-4-8"): (5.0, 25.0),
    ("Anthropic", "fable-5-api"): (10.0, 50.0),
    ("Anthropic", "haiku"): (1.0, 5.0),
    # OpenAI; Codex subscription path, user pays nothing per token
    ("OpenAI", "gpt-5.5"): (0.0, 0.0),
    ("OpenAI", "gpt-5.4"): (0.0, 0.0),
    ("OpenAI", "gpt-5.4-mini"): (0.0, 0.0),
    # Google; Gemini CLI subscription path, user pays nothing per token
    ("Google", "gemini-3.5-flash"): (0.0, 0.0),
    ("Google", "gemini-3.1-flash-lite"): (0.0, 0.0),
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
