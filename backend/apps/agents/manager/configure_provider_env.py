"""Configure the SDK environment for the run's provider route: set ANTHROPIC/OPENAI/GOOGLE
auth env vars (direct key, OpenSwarm Pro proxy, OpenRouter, or 9Router) and pin subagent models,
ensuring 9Router is up where the route needs it."""

import os
from typing import Dict, Optional

from typeguard import typechecked

from backend.apps.agents.core.models import AgentSession
from backend.apps.settings.models import AppSettings
from backend.auth import get_auth_token

logger = __import__("logging").getLogger(__name__)


@typechecked
async def router_available(global_settings: AppSettings) -> bool:
    """True when 9Router is up, reviving it first if it died. A dead router must never masquerade
    as "no provider configured": detection now shares the dispatch path's lazy-start, so a crashed
    or orphaned router self-heals on the very next send instead of erroring the turn. Revival is
    gated on EVIDENCE of a provider (a settings key, proxy mode, or an active connection in the
    router's on-disk db) so a zero-config user keeps the clean no-provider message instead of us
    booting a router with nothing to route."""
    from backend.apps.nine_router import ensure_running as p_ensure, is_running as p_running
    from backend.apps.nine_router.process import has_persisted_connections
    if p_running():
        return True
    p_evidence = any([
        getattr(global_settings, "anthropic_api_key", None),
        getattr(global_settings, "openai_api_key", None),
        getattr(global_settings, "google_api_key", None),
        getattr(global_settings, "openrouter_api_key", None),
        getattr(global_settings, "connection_mode", "own_key") in ("openswarm-pro", "free-trial"),
        bool(getattr(global_settings, "custom_providers", None) or []),
        has_persisted_connections(),
    ])
    if not p_evidence:
        return False
    logger.info("[MCP-DEBUG] 9Router down at provider detection; reviving before concluding")
    await p_ensure()
    return p_running()


@typechecked
async def configure_provider_env(
    options_kwargs: Dict,
    session: AgentSession,
    resolved_model: object,
    api_type: Optional[str],
    global_settings: AppSettings,
) -> None:
    from backend.apps.nine_router import is_running as nine_router_running
    from backend.apps.agents.providers.registry import NINEROUTER_MODEL_PREFIXES as NINEROUTER_MODEL_PREFIXES
    resolved_is_9router = isinstance(resolved_model, str) and resolved_model.startswith(NINEROUTER_MODEL_PREFIXES)

    from backend.apps.agents.providers.registry import find_builtin_model as find_builtin_model
    model_entry = find_builtin_model(session.model)
    is_pinned_api_route = (
        model_entry is not None
        and model_entry.get("route") == "api"
    )
    api_route_provider = (model_entry or {}).get("api") if is_pinned_api_route else None

    if is_pinned_api_route and api_route_provider == "anthropic" and getattr(global_settings, "anthropic_api_key", None):
        options_kwargs["env"] = {
            "ANTHROPIC_API_KEY": global_settings.anthropic_api_key,
            "ANTHROPIC_BASE_URL": "https://api.anthropic.com",
            # Pin subagents so they don't drift back to the proxy.
            "CLAUDE_CODE_SUBAGENT_MODEL": "claude-sonnet-4-6",
            "ANTHROPIC_SMALL_FAST_MODEL": "claude-haiku-4-5",
            "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-haiku-4-5",
        }
        logger.info(f"[MCP-DEBUG] Using direct Anthropic API key (route=api) for {session.model}")
    elif is_pinned_api_route and api_route_provider == "openai" and getattr(global_settings, "openai_api_key", None):
        # openai-passthrough renames max_tokens->max_completion_tokens before relaying (GPT-5 400s on max_tokens; 9Router 0.3.60, pinned for WebSearch, emits the legacy field).
        passthrough_url = f"http://127.0.0.1:{os.environ.get('OPENSWARM_PORT', '8324')}/api/openai-passthrough/v1"
        options_kwargs["env"] = {
            "OPENAI_API_KEY": global_settings.openai_api_key,
            "OPENAI_BASE_URL": passthrough_url,
            "ANTHROPIC_API_KEY": get_auth_token() or "9router",
            "ANTHROPIC_BASE_URL": "http://localhost:20128",
        }
        logger.info(f"[MCP-DEBUG] Using direct OpenAI API key (route=api) for {session.model} via openai-passthrough")
    elif is_pinned_api_route and api_route_provider == "custom":
        # User OpenAI-compatible endpoint (Ollama/Together/LM Studio) via 9Router's synced provider node.
        from backend.apps.nine_router import ensure_running as p_9r_ensure_c
        if not nine_router_running():
            logger.info(f"[MCP-DEBUG] custom provider selected but 9Router not running; waiting for startup")
            await p_9r_ensure_c()
            if not nine_router_running():
                raise ValueError(
                    "9Router could not start. Custom OpenAI-compatible "
                    "providers need 9Router to translate the Anthropic "
                    "protocol, install Node.js and restart the app."
                )
        from backend.apps.agents.providers.registry import find_custom_provider_for_value as find_custom_provider_for_value
        cp = find_custom_provider_for_value(global_settings, session.model)
        env = {
            "ANTHROPIC_API_KEY": "9router",
            "ANTHROPIC_BASE_URL": "http://localhost:20128",
            "ENABLE_TOOL_SEARCH": "auto",
        }
        if cp:
            # Local servers often run auth-disabled; placeholder key since the OpenAI SDK requires non-empty.
            env["OPENAI_API_KEY"] = (cp.api_key or "").strip() or "no-auth-required"
            from backend.apps.nine_router import normalize_openai_compat_base_url as norm_cp_url
            env["OPENAI_BASE_URL"] = norm_cp_url(cp.base_url or "")
        # Pin subagents or CLI's default Haiku 4.5 404s on the custom provider.
        if global_settings.anthropic_api_key:
            env["CLAUDE_CODE_SUBAGENT_MODEL"] = "claude-sonnet-4-6"
            env["ANTHROPIC_SMALL_FAST_MODEL"] = "claude-haiku-4-5-20251001"
            env["ANTHROPIC_DEFAULT_HAIKU_MODEL"] = "claude-haiku-4-5-20251001"
        else:
            # No Anthropic key: pin subagents to the custom model so they stay on the user's endpoint.
            env["CLAUDE_CODE_SUBAGENT_MODEL"] = resolved_model
            env["ANTHROPIC_SMALL_FAST_MODEL"] = resolved_model
            env["ANTHROPIC_DEFAULT_HAIKU_MODEL"] = resolved_model
        options_kwargs["env"] = env
        logger.info(f"[MCP-DEBUG] Using custom provider for {session.model} → {resolved_model}")
    elif is_pinned_api_route and api_route_provider == "gemini" and getattr(global_settings, "google_api_key", None):
        # Local anthropic-proxy scrubs JSON-Schema fields Gemini rejects ($schema, additionalProperties, propertyNames, exclusiveMinimum, nested const) that 9Router 0.3.60 misses.
        proxy_url = f"http://127.0.0.1:{os.environ.get('OPENSWARM_PORT', '8324')}/api/anthropic-proxy"
        options_kwargs["env"] = {
            "GEMINI_API_KEY": global_settings.google_api_key,
            "GOOGLE_API_KEY": global_settings.google_api_key,
            "ANTHROPIC_API_KEY": get_auth_token() or "9router",
            "ANTHROPIC_BASE_URL": proxy_url,
        }
        logger.info(f"[MCP-DEBUG] Using direct Google API key (route=api) for {session.model} via local proxy")
    elif api_type == "openrouter" and getattr(global_settings, "openrouter_api_key", None):
        # OpenRouter via 9Router; with no Anthropic key/sub, fall back to OR's resold Claude for subagents (incl. WebSearch delegation) so they stay on the same OR billing.
        if not nine_router_running():
            from backend.apps.nine_router import ensure_running as nine_router_ensure
            logger.info(f"[MCP-DEBUG] OpenRouter selected but 9Router not running; waiting for startup")
            await nine_router_ensure()
            if not nine_router_running():
                raise ValueError(
                    "9Router could not start. OpenRouter routing requires "
                    "Node.js, install it and restart the app, or pick a "
                    "model that uses a direct API key (Anthropic, OpenAI, "
                    "or Google AI Studio)."
                )
        env = {
            "ANTHROPIC_API_KEY": "9router",
            "ANTHROPIC_BASE_URL": "http://localhost:20128",
        }
        if global_settings.anthropic_api_key:
            env["CLAUDE_CODE_SUBAGENT_MODEL"] = "claude-sonnet-4-6"
            env["ANTHROPIC_SMALL_FAST_MODEL"] = "claude-haiku-4-5-20251001"
            env["ANTHROPIC_DEFAULT_HAIKU_MODEL"] = "claude-haiku-4-5-20251001"
        else:
            env["CLAUDE_CODE_SUBAGENT_MODEL"] = "openrouter/anthropic/claude-sonnet-4.5"
            env["ANTHROPIC_SMALL_FAST_MODEL"] = "openrouter/anthropic/claude-haiku-4.5"
            env["ANTHROPIC_DEFAULT_HAIKU_MODEL"] = "openrouter/anthropic/claude-haiku-4.5"
        env["ENABLE_TOOL_SEARCH"] = "auto"
        options_kwargs["env"] = env
        logger.info(f"[MCP-DEBUG] Using OpenRouter for {session.model}")
    elif api_type == "anthropic" and not resolved_is_9router and getattr(global_settings, "connection_mode", "own_key") in ("openswarm-pro", "free-trial"):
        from backend.apps.settings.credentials import proxy_auth
        bearer, proxy_url = proxy_auth(global_settings)
        bearer = bearer or ""
        options_kwargs["env"] = {
            "ANTHROPIC_AUTH_TOKEN": bearer,
            "ANTHROPIC_BASE_URL": proxy_url,
            # Pin subagents; Pro rejects CLI's default haiku as "No credentials for provider: anthropic".
            "CLAUDE_CODE_SUBAGENT_MODEL": "claude-sonnet-4-6",
            "ANTHROPIC_SMALL_FAST_MODEL": "claude-haiku-4-5-20251001",
            "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-haiku-4-5-20251001",
            # auto: tengu_defer_all_bn4 defers every tool, which collides with cache_control and 400s the first tool-laden request.
            "ENABLE_TOOL_SEARCH": "auto",
        }
        # Tag every call (subagents inherit env) + aux calls with the task id so a query plus its title-gen meter as ONE free run; base goes straight to cloud (no 9Router) so the header rides.
        if getattr(global_settings, "connection_mode", "own_key") == "free-trial":
            options_kwargs["env"]["ANTHROPIC_CUSTOM_HEADERS"] = f"X-Openswarm-Task-Id: {session.id}"
            # Cloud serves every free run as Haiku; keep the subagent on Haiku too (sonnet adds `effort`, Haiku 400s).
            options_kwargs["env"]["CLAUDE_CODE_SUBAGENT_MODEL"] = "claude-haiku-4-5-20251001"
        logger.info(f"[MCP-DEBUG] Using OpenSwarm cloud proxy at {proxy_url}")
    elif api_type == "anthropic" and not resolved_is_9router and global_settings.anthropic_api_key:
        options_kwargs["env"] = {"ANTHROPIC_API_KEY": global_settings.anthropic_api_key}
        logger.info("[MCP-DEBUG] Using direct Anthropic API key")
    elif await router_available(global_settings):
        # Gemini-bound ids go through the local proxy for schema scrubbing; everything else hits 9Router directly.
        is_gemini_bound = (
            isinstance(resolved_model, str)
            and resolved_model.startswith(("gemini/", "gc/", "ag/"))
        )
        if is_gemini_bound:
            base_url = f"http://127.0.0.1:{os.environ.get('OPENSWARM_PORT', '8324')}/api/anthropic-proxy"
            env = {
                "ANTHROPIC_API_KEY": get_auth_token() or "9router",
                "ANTHROPIC_BASE_URL": base_url,
            }
        else:
            env = {
                "ANTHROPIC_API_KEY": "9router",
                "ANTHROPIC_BASE_URL": "http://localhost:20128",
            }
        # Pin subagents to whichever lane the user has, else the CLI's default Haiku 4.5 hits 9Router with no Claude route and every sub-agent 401s while the parent turn works. Fetched live here (fail-open []) so no caller can starve the pin with a stale list again, the run/ split did exactly that and silently killed sub-agents on router routes.
        from backend.apps.nine_router import get_providers as p_get_providers
        sub_conns = await p_get_providers()
        active = {c.get("provider") for c in sub_conns
                   if isinstance(c, dict) and c.get("isActive")}
        sub_model = None
        small_model = None
        if global_settings.anthropic_api_key:
            sub_model = "claude-sonnet-4-6"
            small_model = "claude-haiku-4-5-20251001"
        elif "claude" in active or "anthropic" in active:
            sub_model = "cc/claude-sonnet-4-6"
            small_model = "cc/claude-haiku-4-5-20251001"
        elif "antigravity" in active:
            sub_model = "ag/gemini-3-flash"
            small_model = "ag/gemini-3-flash"
        elif "gemini-cli" in active:
            sub_model = "gc/gemini-2.5-flash"
            small_model = "gc/gemini-2.5-flash"
        elif "codex" in active:
            sub_model = "cx/gpt-5.4-mini"
            small_model = "cx/gpt-5.4-mini"
        if sub_model:
            env["CLAUDE_CODE_SUBAGENT_MODEL"] = sub_model
        if small_model:
            env["ANTHROPIC_SMALL_FAST_MODEL"] = small_model
            env["ANTHROPIC_DEFAULT_HAIKU_MODEL"] = small_model
        logger.info(
            f"[MCP-DEBUG] 9Router direct, subagent_model={sub_model}, small_fast={small_model}"
        )
        # auto eagerly loads tools when the schema budget fits; without it tengu_defer_all_bn4 defers 16 tools unloadable off Anthropic networks. Don't use --bare (strips system prompt).
        env["ENABLE_TOOL_SEARCH"] = "auto"
        options_kwargs["env"] = env
        logger.info(f"[MCP-DEBUG] Using 9Router (api_type={api_type})")
    else:
        # router_available() above already attempted a revival; reaching here means it truly can't start.
        if api_type != "anthropic" or resolved_is_9router:
            raise ValueError(
                f"9Router is not running; cannot use {session.model}. "
                "Install Node.js and restart the app, or switch to a model "
                "with a direct API key."
            )
        raise ValueError("No AI provider configured. Set an API key or connect a subscription.")
