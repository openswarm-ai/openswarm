"""Provider registry and model catalog.

Live agent path goes through claude_agent_sdk via agent_manager._run_agent_loop.
Non-Anthropic models route through 9Router's /v1/messages endpoint with
prefixed ids (cx/gpt-5.4, gc/gemini-3-pro-preview).
"""

from __future__ import annotations

import logging
from typing import Any, TYPE_CHECKING

if TYPE_CHECKING:
    from backend.apps.settings.models import AppSettings

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Tier 1: Built-in models (curated, we know their quirks)
# ---------------------------------------------------------------------------
#
# Fields:
#   value            — short internal name stored on AgentSession.model
#   label            — display name in the model picker
#   context_window   — tokens
#   model_id         — bare model string for direct API calls (Anthropic key path)
#   router_model_id  — prefixed string for 9Router routing (cc/, cx/, gc/)
#   api              — "anthropic" | "codex" | "gemini-cli"
#   subscription_only— True means hidden from picker unless 9Router has that
#                      provider actively connected
#   reasoning        — True for models that emit Anthropic `thinking` content
#                      blocks via 9Router's translator. OpenSwarm's stream
#                      handler at agent_manager.py:1141-1165 does not yet
#                      render these blocks — final text still appears but
#                      the reasoning trace is silently dropped. Tracked as
#                      a follow-up; add a `thinking` case to the handler
#                      to surface the trace.
#
# Model IDs match 9Router's internal routing catalog at
# 9router/src/shared/constants/pricing.js. Each provider has a distinct
# model-name convention:
#   - cc/  (Claude Code subscription) uses dash-notation: claude-sonnet-4-6
#   - cx/  (OpenAI Codex subscription) uses dot-notation with -codex suffix.
#          Note: `gpt-5.4` is NOT available on this path — it's API-key-only.
#          The Codex subscription's flagship is gpt-5.3-codex.
#   - gc/  (Gemini CLI subscription) uses gemini-3-pro-preview / 3-flash-preview
#          (Gemini 3 family — thinking-capable). 2.5 models removed.
#          Gemini 3 thought signatures handled via skip_thought_signature_validator.

BUILTIN_MODELS: dict[str, list[dict[str, Any]]] = {
    # Anthropic: Sonnet 4.6 (Feb 17 2026), Opus 4.6 (Feb 5 2026),
    # Haiku 4.5 (Oct 2025). Opus 4.7 was briefly exposed but pulled —
    # the Claude Code SDK currently elides plaintext thinking deltas
    # for 4.7 (encrypted/redacted blocks only), which broke the
    # "Thought for Ns" pill UX. Re-add once Anthropic ships the
    # plaintext summarizer for 4.7.
    "Anthropic": [
        # Adaptive entries: route is chosen at call time based on
        # settings.connection_mode (openswarm-pro → proxy; api_key → direct;
        # else → 9Router cc/).
        {"value": "sonnet", "label": "Claude Sonnet 4.6", "context_window": 1_000_000,
         "model_id": "claude-sonnet-4-6", "router_model_id": "cc/claude-sonnet-4-6", "api": "anthropic", "reasoning": True},
        {"value": "opus", "label": "Claude Opus 4.6", "context_window": 1_000_000,
         "model_id": "claude-opus-4-6", "router_model_id": "cc/claude-opus-4-6", "api": "anthropic", "reasoning": True},
        {"value": "haiku", "label": "Claude Haiku 4.5", "context_window": 200_000,
         "model_id": "claude-haiku-4-5", "router_model_id": "cc/claude-haiku-4-5-20251001", "api": "anthropic", "reasoning": True},
        # Pinned-subscription entries: always route via 9Router's `cc/` prefix
        # (the user's personal Claude Pro/Max subscription), regardless of
        # connection_mode. Surfaced in list_models only when the user has
        # BOTH openswarm-pro active AND the 9Router `claude` subscription
        # connected — so the model picker can offer a per-call choice between
        # the managed OpenSwarm proxy and their own Claude subscription.
        {"value": "sonnet-cc", "label": "Claude Sonnet 4.6", "context_window": 1_000_000,
         "model_id": "claude-sonnet-4-6", "router_model_id": "cc/claude-sonnet-4-6", "api": "anthropic", "reasoning": True, "route": "cc"},
        {"value": "opus-cc", "label": "Claude Opus 4.6", "context_window": 1_000_000,
         "model_id": "claude-opus-4-6", "router_model_id": "cc/claude-opus-4-6", "api": "anthropic", "reasoning": True, "route": "cc"},
        {"value": "haiku-cc", "label": "Claude Haiku 4.5", "context_window": 200_000,
         "model_id": "claude-haiku-4-5", "router_model_id": "cc/claude-haiku-4-5-20251001", "api": "anthropic", "reasoning": True, "route": "cc"},

        {"value": "sonnet-api", "label": "Claude Sonnet 4.6 (API key)", "context_window": 1_000_000,
         "model_id": "claude-sonnet-4-6", "router_model_id": "claude-sonnet-4-6", "api": "anthropic", "reasoning": True, "route": "api"},
        {"value": "opus-api", "label": "Claude Opus 4.6 (API key)", "context_window": 1_000_000,
         "model_id": "claude-opus-4-6", "router_model_id": "claude-opus-4-6", "api": "anthropic", "reasoning": True, "route": "api"},
        {"value": "haiku-api", "label": "Claude Haiku 4.5 (API key)", "context_window": 200_000,
         "model_id": "claude-haiku-4-5", "router_model_id": "claude-haiku-4-5", "api": "anthropic", "reasoning": True, "route": "api"},
    ],
  
    "OpenAI": [
        # GPT-5.5 — newest ChatGPT flagship (May 2026). Available via
        # the Codex subscription path on 9Router 0.4.x catalogs; on
        # 0.3.60 (our pin) the cx/ catalog stops at gpt-5.4, so the
        # subscription-routed entry will 404 until we bump. The
        # API-key entry below works today against api.openai.com.
        {"value": "gpt-5.5", "label": "GPT-5.5",
         "context_window": 1_000_000, "router_model_id": "cx/gpt-5.5",
         "api": "codex", "subscription_only": True, "reasoning": True},
        {"value": "gpt-5.4", "label": "GPT-5.4",
         "context_window": 1_000_000, "router_model_id": "cx/gpt-5.4",
         "api": "codex", "subscription_only": True, "reasoning": True},
        {"value": "gpt-5.4-mini", "label": "GPT-5.4 Mini",
         "context_window": 400_000, "router_model_id": "cx/gpt-5.4-mini",
         "api": "codex", "subscription_only": True, "reasoning": True},
        # GPT-5.3 Codex variants. The bare `gpt-5.3-codex` adapts reasoning
        # effort from session.thinking_level. The -high / -xhigh suffixes
        # are distinct codex tunes from OpenAI optimized for longer-horizon
        # coding (xhigh = max-quality, slowest). Both are surfaced for users
        # who want to pin effort independently of the global thinking knob.
        {"value": "gpt-5.3-codex", "label": "GPT-5.3 Codex",
         "context_window": 400_000, "router_model_id": "cx/gpt-5.3-codex",
         "api": "codex", "subscription_only": True, "reasoning": True},
        {"value": "gpt-5.3-codex-high", "label": "GPT-5.3 Codex High",
         "context_window": 400_000, "router_model_id": "cx/gpt-5.3-codex-high",
         "api": "codex", "subscription_only": True, "reasoning": True},
        {"value": "gpt-5.3-codex-xhigh", "label": "GPT-5.3 Codex Extra High",
         "context_window": 400_000, "router_model_id": "cx/gpt-5.3-codex-xhigh",
         "api": "codex", "subscription_only": True, "reasoning": True},
        # Pinned-API-key entries: bypass 9Router and call api.openai.com
        # directly with openai_api_key. Model ids match what OpenAI's API
        # accepts (no cx/ prefix). Surfaced when openai_api_key is set —
        # gives a metered alternative to the ChatGPT-Plus subscription
        # route. Same -api suffix convention as the Anthropic mirrors.
        {"value": "gpt-5.5-api", "label": "GPT-5.5 (API key)",
         "context_window": 1_000_000, "router_model_id": "gpt-5.5", "model_id": "gpt-5.5",
         "api": "openai", "reasoning": True, "route": "api"},
        {"value": "gpt-5.4-api", "label": "GPT-5.4 (API key)",
         "context_window": 1_000_000, "router_model_id": "gpt-5.4", "model_id": "gpt-5.4",
         "api": "openai", "reasoning": True, "route": "api"},
        {"value": "gpt-5.4-mini-api", "label": "GPT-5.4 Mini (API key)",
         "context_window": 400_000, "router_model_id": "gpt-5.4-mini", "model_id": "gpt-5.4-mini",
         "api": "openai", "reasoning": True, "route": "api"},
        {"value": "gpt-5.3-codex-api", "label": "GPT-5.3 Codex (API key)",
         "context_window": 400_000, "router_model_id": "gpt-5.3-codex", "model_id": "gpt-5.3-codex",
         "api": "openai", "reasoning": True, "route": "api"},
        {"value": "gpt-5.3-codex-high-api", "label": "GPT-5.3 Codex High (API key)",
         "context_window": 400_000, "router_model_id": "gpt-5.3-codex-high", "model_id": "gpt-5.3-codex-high",
         "api": "openai", "reasoning": True, "route": "api"},
        {"value": "gpt-5.3-codex-xhigh-api", "label": "GPT-5.3 Codex Extra High (API key)",
         "context_window": 400_000, "router_model_id": "gpt-5.3-codex-xhigh", "model_id": "gpt-5.3-codex-xhigh",
         "api": "openai", "reasoning": True, "route": "api"},
    ],
    # Google: Gemini via Gemini CLI subscription. Both 3.x (thinking-
    # capable) and 2.5 (stable) are offered. Gemini 3 models have
    # always-on thinking with per-session thought signatures that are
    # lost during the format translation round-trip. We use Google's
    # official workaround: `skip_thought_signature_validator` on all
    # historical function call and thinking parts (see 9router
    # openai-to-gemini.js). This bypasses signature validation at the
    # cost of the model not being able to build on prior reasoning
    # across turns — but all tools work and thinking is visible.
    "Google": [
        # Gemini 3.1 Pro — newest flagship (Apr 2026), routes to
        # `gc/gemini-3.1-pro-preview` for the subscription path. Same
        # thoughtSignature caveat applies; resolve_model_id_for_sdk's
        # Antigravity map handles the multi-step routing.
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
        # Pinned-API-key entries for Google AI Studio (api="gemini"). Bypass
        # both 9Router (which routes via Gemini CLI/Antigravity OAuth) and
        # any subscription path; call generativelanguage.googleapis.com
        # directly with google_api_key. Free-tier quota is generous (~1K
        # requests/day) and lives separately from the OAuth lanes.
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
# Thinking level translation
# ---------------------------------------------------------------------------
# Each provider has a different API shape for "how hard should the model
# think." We expose a single provider-agnostic level (off/low/medium/high/
# auto) on the session and translate here.
#
# Returns the provider-specific payload to merge into request params, or
# None if no special thinking params should be sent (use defaults).

def thinking_params_for(api: str, level: str, model_id: str = "") -> dict | None:
    """Translate a provider-agnostic thinking level to per-provider API params.

    Args:
        api: "anthropic" | "codex" | "gemini-cli"
        level: "off" | "low" | "medium" | "high" | "auto"
        model_id: optional, used to pick adaptive vs legacy for Claude

    Returns a dict to merge into request params, or None for "use defaults".
    """
    if level == "auto":
        # Let provider use its own default. For Claude 4.6 we still want
        # adaptive thinking on by default so users see reasoning.
        if api == "anthropic":
            return {"thinking": {"type": "adaptive"}}
        return None

    if level == "off":
        if api == "anthropic":
            return {"thinking": {"type": "disabled"}}
        if api == "codex":
            return {"reasoning": {"effort": "none"}}
        # Gemini: thinkingBudget=0 truly disables reasoning (no
        # thoughtSignature emitted). Critical for multi-step tool turns
        # — without this Gemini 2.5/3.x still emits signatures even at
        # the lowest "level," which then break the next request with
        # "Thought signature is not valid" 400 because the SDK has no
        # way to round-trip them. The translator at 9Router 0.3.60
        # explicitly checks `thinkingBudget == 0` to skip emitting
        # thinking config, which is what we want.
        if api == "gemini-cli":
            return {"thinkingConfig": {"thinkingBudget": 0}}
        return None

    # Claude 4.6 models use adaptive thinking (no manual budget). For older
    # Claude models we'd use budget_tokens; we don't ship those today.
    if api == "anthropic":
        return {"thinking": {"type": "adaptive"}}

    if api == "codex":
        effort_map = {"low": "low", "medium": "medium", "high": "high"}
        return {"reasoning": {"effort": effort_map[level]}}

    if api == "gemini-cli":
        level_map = {"low": "LOW", "medium": "MEDIUM", "high": "HIGH"}
        return {"thinkingConfig": {"thinkingLevel": level_map[level]}}

    return None


# ---------------------------------------------------------------------------
# OpenRouter: built-in integration for 300+ models
# ---------------------------------------------------------------------------

OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"

_9router_cache: dict = {"available": None, "checked_at": 0}


def _is_9router_available() -> bool:
    """Check if 9Router is running on localhost:20128. Caches for 30 seconds."""
    import time as _time
    now = _time.time()
    if _9router_cache["available"] is not None and now - _9router_cache["checked_at"] < 30:
        return _9router_cache["available"]
    try:
        import httpx
        r = httpx.get("http://localhost:20128/v1/models", timeout=2.0)
        available = r.status_code == 200
    except Exception:
        available = False
    _9router_cache["available"] = available
    _9router_cache["checked_at"] = now
    return available


# ---------------------------------------------------------------------------
# Model resolution (used by the live claude_agent_sdk path)
# ---------------------------------------------------------------------------

def _find_builtin_model(short_name: str) -> dict | None:
    """Look up a model entry by its short `value`."""
    for models in BUILTIN_MODELS.values():
        for m in models:
            if m.get("value") == short_name:
                return m
    return None


def get_api_type(short_name: str) -> str:
    """Return the api type for a short model name.

    Returns one of: "anthropic", "codex", "gemini-cli".
    Defaults to "anthropic" for unknown names so existing behavior is preserved.
    """
    entry = _find_builtin_model(short_name)
    return (entry or {}).get("api", "anthropic")


def resolve_model_id_for_sdk(short_name: str, settings: AppSettings) -> str:
    """Resolve a short model name into the id string passed to ClaudeAgentOptions.

    Priority:
    - Anthropic model + openswarm-pro mode → bare `model_id` (our cloud proxy)
    - Anthropic model with an API key set → bare `model_id` (real Anthropic API)
    - Everything else → `router_model_id` (9Router with cc/ cx/ gc/ prefix)
    - Unknown names pass through unchanged
    """
    entry = _find_builtin_model(short_name)
    if entry is None:
        return short_name
    # Pinned-route entries (e.g. "sonnet-cc") always use their router_model_id,
    # bypassing connection_mode. This is what lets the picker offer a
    # distinct "Anthropic" group pointing at the user's 9Router Claude
    # subscription even while openswarm-pro is the default Claude route.
    if entry.get("route") == "cc":
        return entry.get("router_model_id", entry.get("model_id", short_name))
    # route="api" is the analogue for the user's direct Anthropic API key:
    # bare model_id, and agent_manager will force the spawn env to point at
    # api.anthropic.com with the api_key (skipping both the Pro proxy AND
    # 9Router). This is what makes "use my API key" reachable even when
    # connection_mode is openswarm-pro.
    if entry.get("route") == "api":
        return entry.get("model_id", short_name)
    if entry.get("api") == "anthropic":
        if getattr(settings, "connection_mode", "own_key") == "openswarm-pro":
            return entry.get("model_id", short_name)
        if getattr(settings, "anthropic_api_key", None):
            return entry.get("model_id", short_name)
    # Gemini: prefer lanes with higher quota in order —
    #   1. AI Studio apikey (free 1K/day, separate from any OAuth limit)
    #   2. Antigravity OAuth (preview, 5-10× the Gemini CLI free tier).
    #      CRITICAL: Antigravity's wrapper around Google's API doesn't
    #      enforce the strict thoughtSignature continuity check that
    #      breaks multi-step tool turns through Gemini CLI. Without
    #      this lane, agent turns that combine thinking + tool use get
    #      "Thought signature is not valid" 400s on every follow-up
    #      request because the claude_agent_sdk has no hook to round-
    #      trip Gemini-specific signatures.
    #   3. Gemini CLI OAuth (free tier, ~5 RPM — last resort, breaks
    #      on multi-step agent turns).
    #
    # Antigravity exposes differently-named Gemini models than Gemini CLI:
    #   gc/gemini-3-pro-preview  →  ag/gemini-3.1-pro-high (DISABLED —
    #     Google returns 404 not_found_error on this even with an
    #     active Antigravity connection; tier-side access gate.)
    #   gc/gemini-3-flash-preview →  ag/gemini-3-flash (works)
    # Models Antigravity doesn't have (or that 404) fall through to gc/.
    _ANTIGRAVITY_MAP = {
        # Disabled until 9Router exposes per-model availability so we
        # can verify pro-high is actually serviceable before routing.
        # "gemini-3-pro-preview": "gemini-3.1-pro-high",
        "gemini-3-flash-preview": "gemini-3-flash",
        # Gemini 3.1 family — same thoughtSignature problem as 3.0:
        # gc/ enforces continuity, the Anthropic SDK has no hook to
        # round-trip the signature, every multi-step tool turn 400s
        # with "Thought signature is not valid". Routing through
        # ag/ (Antigravity wrapper around Google's API) sidesteps
        # the validator. AG is flagged deprecated upstream — we keep
        # using it on 9router 0.3.60 (our pin) as the only working
        # multi-step Gemini path; will revisit once the SDK gets
        # signature passthrough or 9router lands a Gemini-CLI fix.
        "gemini-3.1-pro-preview": "gemini-3.1-pro-high",
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
                # Check 9Router for an Antigravity connection.
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
    """Pick the cheapest/most-available model for auxiliary LLM calls.

    Used by title generation, group meta, dashboard naming, outputs/view
    builder, and browser_agent — wherever we need a quick one-shot LLM call
    that is NOT the user's selected chat model.

    Args:
        primary_api: when set, prefer this provider family ("anthropic" |
            "codex" | "gemini-cli") over the default Anthropic-first cascade.
            Lets a Codex-only or Gemini-only session keep aux work on the
            same family it's already paying for, instead of leaking to
            Anthropic Haiku just because the user *also* has Anthropic
            connected. Caller passes `get_api_type(session.model)`.

    Returns (model_id, base_url).
    - If base_url is None, caller should use the default Anthropic client.
    - If base_url is set, caller should route through that endpoint.

    Priority (when primary_api is None, classic cascade):
    1. OpenSwarm Pro mode → bare haiku/sonnet via proxy
    2. Anthropic API key set → bare haiku/sonnet on real Anthropic API
    3. 9Router + Claude subscription connected → cc/<model>
    4. 9Router + Codex connected → cx/gpt-5.4-mini
    5. 9Router + Gemini connected → gc/gemini-3.1-flash-lite-preview
    6. Nothing available → raise ValueError

    When primary_api is provided, the resolver tries that family first
    (subscription path then API key) and only falls through to other
    providers if the primary family isn't reachable.
    """
    haiku_bare = "claude-haiku-4-5-20251001"
    sonnet_bare = "claude-sonnet-4-20250514"
    bare = haiku_bare if preferred_tier == "haiku" else sonnet_bare

    # Probe 9Router once up front so the primary_api branch and the
    # default cascade share the same connection set.
    from backend.apps.nine_router import is_running as _9r_running, get_providers as _9r_providers

    base_url = "http://localhost:20128"
    connected: set[str] = set()
    if _9r_running():
        try:
            connections = await _9r_providers()
            connected = {c.get("provider") for c in connections if c.get("isActive")}
        except Exception:
            connected = set()

    # Match primary_api first when supplied. Each branch checks both the
    # subscription path (preferred — usually free) and the direct-API path
    # before giving up on this family.
    if primary_api == "codex":
        if "codex" in connected:
            return ("cx/gpt-5.4-mini", base_url)
        if getattr(settings, "openai_api_key", None):
            return ("gpt-5.4-mini", "https://api.openai.com/v1")
        # primary is Codex but it's not reachable — fall through to default
    elif primary_api == "gemini-cli" or primary_api == "gemini":
        if "gemini-cli" in connected:
            return ("gc/gemini-3.1-flash-lite-preview", base_url)
        if getattr(settings, "google_api_key", None):
            return ("gemini-3.1-flash-lite-preview", "https://generativelanguage.googleapis.com/v1beta")
        # fall through to default
    # primary_api == "anthropic" naturally falls into the Anthropic-first
    # cascade below — no special branch needed.

    # OpenSwarm Pro — route through our cloud proxy
    if getattr(settings, "connection_mode", "own_key") == "openswarm-pro":
        proxy_url = getattr(settings, "openswarm_proxy_url", None) or "https://api.openswarm.com"
        return (bare, proxy_url)

    # Direct API key wins
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

    # Check custom providers
    if settings:
        for cp in getattr(settings, "custom_providers", []):
            for m in cp.models:
                if m.get("value") == model or m.get("id") == model:
                    return m.get("context_window", 128_000)

    return 128_000  # safe default


# ---------------------------------------------------------------------------
# Cost tracking
# ---------------------------------------------------------------------------

COST_PER_1M_TOKENS: dict[tuple[str, str], tuple[float, float]] = {
    # (provider, model): (input_cost_per_1M, output_cost_per_1M)
    # NOTE: `calculate_cost` is currently unused in the live path — real
    # cost numbers come from 9Router's usage stats. These entries are kept
    # so the table matches BUILTIN_MODELS and can
    # be used by any future native-loop path. Subscription-routed models
    # are zero-cost to the user, but API rates are recorded here for
    # reference where they exist.
    # Anthropic (direct API rates).
    ("Anthropic", "sonnet"): (3.0, 15.0),
    ("Anthropic", "opus"): (5.0, 25.0),
    ("Anthropic", "haiku"): (1.0, 5.0),
    # OpenAI — Codex subscription path, user pays nothing per token
    ("OpenAI", "gpt-5.5"): (0.0, 0.0),
    ("OpenAI", "gpt-5.4"): (0.0, 0.0),
    ("OpenAI", "gpt-5.4-mini"): (0.0, 0.0),
    ("OpenAI", "gpt-5.3-codex"): (0.0, 0.0),
    ("OpenAI", "gpt-5.3-codex-high"): (0.0, 0.0),
    ("OpenAI", "gpt-5.3-codex-xhigh"): (0.0, 0.0),
    # Google — Gemini CLI subscription path, user pays nothing per token
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


def calculate_cost(
    provider: str, model: str,
    input_tokens: int, output_tokens: int,
) -> float:
    """Calculate cost in USD from token counts."""
    # Direct lookup first
    rates = COST_PER_1M_TOKENS.get((provider, model))
    if not rates:
        # Case-insensitive provider lookup
        lower = provider.lower()
        for (p, m), r in COST_PER_1M_TOKENS.items():
            if p.lower() == lower and m == model:
                rates = r
                break
    if not rates:
        return 0.0
    input_rate, output_rate = rates
    return (input_tokens * input_rate + output_tokens * output_rate) / 1_000_000
