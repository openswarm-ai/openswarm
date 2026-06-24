"""Configure the SDK environment for the run's provider route: set ANTHROPIC/OPENAI/GOOGLE
auth env vars (direct key, OpenSwarm Pro proxy, OpenRouter, or 9Router) and pin subagent models,
ensuring 9Router is up where the route needs it. Lifted out of the agent loop; mutates
options_kwargs[\"env\"] in place exactly as inline. sub_conns is the active-connection list used
for subagent-model fallback (empty today)."""

import os
from typing import Dict, List, Optional

from typeguard import typechecked

from backend.apps.agents.core.models import AgentSession
from backend.auth import get_auth_token

logger = __import__("logging").getLogger(__name__)


@typechecked
async def configure_provider_env(
    options_kwargs: Dict,
    session: AgentSession,
    resolved_model: object,
    api_type: Optional[str],
    global_settings: object,
    sub_conns: List,
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
            # Pin subagent envs so they don't drift back to the proxy.
            "CLAUDE_CODE_SUBAGENT_MODEL": "claude-sonnet-4-6",
            "ANTHROPIC_SMALL_FAST_MODEL": "claude-haiku-4-5",
            "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-haiku-4-5",
        }
        logger.info(f"[MCP-DEBUG] Using direct Anthropic API key (route=api) for {session.model}")
    elif is_pinned_api_route and api_route_provider == "openai" and getattr(global_settings, "openai_api_key", None):
        # Goes through 9Router's Anthropic→OpenAI translator like
        # other own-key routes, but we point OPENAI_BASE_URL at a
        # tiny local pass-through (/api/openai-passthrough/v1) that
        # renames max_tokens → max_completion_tokens before relaying
        # to api.openai.com. OpenAI's GPT-5 family rejects max_tokens
        # with HTTP 400, and 9Router 0.3.60 doesn't know about
        # max_completion_tokens yet (its CLI<->OpenAI translator
        # emits the legacy field). The pin on 0.3.60 is intentional
        # (newer 9Router versions regress WebSearch, see
        # nine_router.py comment) so we patch the boundary instead
        # of bumping. Pre-fix: every gpt-5.* / gpt-5.* own-key
        # session 400'd silently.
        passthrough_url = f"http://127.0.0.1:{os.environ.get('OPENSWARM_PORT', '8324')}/api/openai-passthrough/v1"
        options_kwargs["env"] = {
            "OPENAI_API_KEY": global_settings.openai_api_key,
            "OPENAI_BASE_URL": passthrough_url,
            "ANTHROPIC_API_KEY": get_auth_token() or "9router",
            "ANTHROPIC_BASE_URL": "http://localhost:20128",
        }
        logger.info(f"[MCP-DEBUG] Using direct OpenAI API key (route=api) for {session.model} via openai-passthrough")
    elif is_pinned_api_route and api_route_provider == "custom":
        # User-configured OpenAI-compatible endpoint (Ollama Cloud,
        # Together, local Ollama, etc.). Routes through 9Router's
        # openai-compatible provider node we synced from settings.
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
            # Local OpenAI-compatible servers (LM Studio, Ollama, ...)
            # often run with auth disabled, the user leaves api_key
            # blank in Settings. The OpenAI-style SDK insists on a
            # non-empty key; substitute a harmless placeholder so the
            # CLI can issue requests. Servers that DO check auth always
            # have a real key configured.
            env["OPENAI_API_KEY"] = (cp.api_key or "").strip() or "no-auth-required"
            from backend.apps.nine_router import normalize_openai_compat_base_url as norm_cp_url
            env["OPENAI_BASE_URL"] = norm_cp_url(cp.base_url or "")
        # Pin subagent ids, without these, CLI's default Haiku 4.5
        # gets sent to the custom provider and 404s.
        if global_settings.anthropic_api_key:
            env["CLAUDE_CODE_SUBAGENT_MODEL"] = "claude-sonnet-4-6"
            env["ANTHROPIC_SMALL_FAST_MODEL"] = "claude-haiku-4-5-20251001"
            env["ANTHROPIC_DEFAULT_HAIKU_MODEL"] = "claude-haiku-4-5-20251001"
        else:
            # Pin to the same custom-provider model so subagents stay
            # within the user's configured endpoint instead of hitting
            # an unconfigured Anthropic lane.
            env["CLAUDE_CODE_SUBAGENT_MODEL"] = resolved_model
            env["ANTHROPIC_SMALL_FAST_MODEL"] = resolved_model
            env["ANTHROPIC_DEFAULT_HAIKU_MODEL"] = resolved_model
        options_kwargs["env"] = env
        logger.info(f"[MCP-DEBUG] Using custom provider for {session.model} → {resolved_model}")
    elif is_pinned_api_route and api_route_provider == "gemini" and getattr(global_settings, "google_api_key", None):
        # Routed through the local anthropic-proxy so it can scrub the
        # JSON-Schema fields Gemini's API rejects ($schema, additionalProperties,
        # propertyNames, exclusiveMinimum, nested const) that 9Router 0.3.60 misses.
        proxy_url = f"http://127.0.0.1:{os.environ.get('OPENSWARM_PORT', '8324')}/api/anthropic-proxy"
        options_kwargs["env"] = {
            "GEMINI_API_KEY": global_settings.google_api_key,
            "GOOGLE_API_KEY": global_settings.google_api_key,
            "ANTHROPIC_API_KEY": get_auth_token() or "9router",
            "ANTHROPIC_BASE_URL": proxy_url,
        }
        logger.info(f"[MCP-DEBUG] Using direct Google API key (route=api) for {session.model} via local proxy")
    elif api_type == "openrouter" and getattr(global_settings, "openrouter_api_key", None):
        # OpenRouter primary. The route="openrouter" entry's
        # router_model_id is `openrouter/<vendor>/<model>` so
        # 9Router routes via the apikey connection synced from
        # CLI's WebSearch delegation needs an Anthropic-shaped lane;
        # if the user has no Anthropic key/sub/Pro, fall back to OR's
        # resold Claude so subagents stay on the same OR billing.
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
            # Pin subagent ids; CLI default 'claude-haiku-4-5-20251001'
            # gets rejected by Pro's surface as "No credentials for provider: anthropic".
            # (Free-trial clamps to its allowed Claude set + weights credits server-side.)
            "CLAUDE_CODE_SUBAGENT_MODEL": "claude-sonnet-4-6",
            "ANTHROPIC_SMALL_FAST_MODEL": "claude-haiku-4-5-20251001",
            "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-haiku-4-5-20251001",
            # auto, never the bare default: tengu_defer_all_bn4 marks every tool
            # defer_loading=true, which collides with our cache_control and 400s the
            # first tool-laden request (the other anthropic branches all set this).
            "ENABLE_TOOL_SEARCH": "auto",
        }
        # Free lane meters one run per agent task: tag every call of this task (and its
        # subagents, which inherit the env) AND its aux calls (title-gen, see generate_title)
        # with the session id, so a query plus its title generation is ONE run, not two.
        # The base goes straight to the cloud (no 9Router), so the header rides through.
        if getattr(global_settings, "connection_mode", "own_key") == "free-trial":
            options_kwargs["env"]["ANTHROPIC_CUSTOM_HEADERS"] = f"X-Openswarm-Task-Id: {session.id}"
            # The cloud serves every free run as Haiku, so keep the subagent on Haiku too:
            # a sonnet subagent makes the CLI attach `effort`, which Haiku 400s on.
            options_kwargs["env"]["CLAUDE_CODE_SUBAGENT_MODEL"] = "claude-haiku-4-5-20251001"
        logger.info(f"[MCP-DEBUG] Using OpenSwarm cloud proxy at {proxy_url}")
    elif api_type == "anthropic" and not resolved_is_9router and global_settings.anthropic_api_key:
        options_kwargs["env"] = {"ANTHROPIC_API_KEY": global_settings.anthropic_api_key}
        logger.info("[MCP-DEBUG] Using direct Anthropic API key")
    elif nine_router_running():
        # Gemini-bound ids go through the local proxy for schema scrubbing;
        # everything else hits 9Router directly.
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
        # Pin subagent ids to whichever lane the user has, else CLI's
        # default Haiku 4.5 hits 9Router with no Claude route and 401s.
        try:
            sub_conns = _conns  # reuse list fetched above
        except NameError:
            sub_conns = []
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
        # ENABLE_TOOL_SEARCH=auto: without it, CLI's tengu_defer_all_bn4
        # Statsig flag defers 16 tools with no way to load them on non-
        # Anthropic networks. "auto" eagerly loads tools when schema
        # budget fits in ~10% of context. Don't pass --bare, sets
        # CLAUDE_CODE_SIMPLE=1 which strips the system prompt scaffolding.
        env["ENABLE_TOOL_SEARCH"] = "auto"
        options_kwargs["env"] = env
        logger.info(f"[MCP-DEBUG] Using 9Router (api_type={api_type})")
    else:
        if api_type != "anthropic":
            from backend.apps.nine_router import ensure_running as nine_router_ensure
            logger.info(f"[MCP-DEBUG] 9Router not running for non-Anthropic model {session.model}; waiting for startup")
            await nine_router_ensure()
            if nine_router_running():
                options_kwargs["env"] = {
                    "ANTHROPIC_API_KEY": "9router",
                    "ANTHROPIC_BASE_URL": "http://localhost:20128",
                }
                logger.info(f"[MCP-DEBUG] 9Router started; routing {session.model} via 9Router")
            else:
                raise ValueError(
                    f"9Router is not running; cannot use {session.model}. "
                    "Install Node.js and restart the app, or switch to a model "
                    "with a direct API key."
                )
        else:
            raise ValueError("No AI provider configured. Set an API key or connect a subscription.")
