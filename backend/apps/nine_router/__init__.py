"""Auto-start and manage the 9Router subprocess.

9Router is a free AI subscription proxy that lets users connect their
Claude/ChatGPT/Gemini subscriptions to OpenSwarm without API keys. It runs
silently on port 20128 and exposes an OpenAI-compatible API at
localhost:20128/v1.

This package was split out of a single ~1190-line module. The public API is
unchanged: every `from backend.apps.nine_router import X` keeps resolving via
the re-exports below.

- process.py: subprocess lifecycle (the single owner of the process handle),
  constants, ports/URLs, the pinned NPM version, path resolution, stats.
- sync.py: Gemini/OpenAI/OpenRouter API-key sync.
- sync_custom.py: custom OpenAI-compatible provider + OpenSwarm Pro sync.
- oauth.py: OAuth start/poll/exchange + the Codex 1455 callback listener.
"""

import httpx  # noqa: F401  patch point: tests stub backend.apps.nine_router.httpx.AsyncClient

from .process import (
    NINE_ROUTER_API,
    NINE_ROUTER_NPM_VERSION,
    NINE_ROUTER_PORT,
    NINE_ROUTER_URL,
    NINE_ROUTER_V1,
    ensure_running,
    get_latest_reasoning_tokens,
    get_providers,
    get_usage_stats,
    is_running,
    stop,
)
from .sync import (
    NINE_ROUTER_CLAUDE_PRO_NAME,
    NINE_ROUTER_KEYED_NAME,
    NINE_ROUTER_OPENAI_KEYED_NAME,
    NINE_ROUTER_OPENAI_KEYED_PREFIX,
    NINE_ROUTER_OPENROUTER_KEYED_NAME,
    sync_gemini_api_key,
    sync_openai_api_key,
    sync_openrouter_api_key,
)
from .sync_custom import (
    NINE_ROUTER_CUSTOM_NAME_SUFFIX,
    normalize_openai_compat_base_url,
    sync_custom_providers,
    sync_openswarm_pro_as_claude,
)
from .oauth import (
    exchange_oauth,
    get_models,
    poll_oauth,
    start_oauth,
)

__all__ = [
    "NINE_ROUTER_API",
    "NINE_ROUTER_NPM_VERSION",
    "NINE_ROUTER_PORT",
    "NINE_ROUTER_URL",
    "NINE_ROUTER_V1",
    "NINE_ROUTER_CLAUDE_PRO_NAME",
    "NINE_ROUTER_KEYED_NAME",
    "NINE_ROUTER_OPENAI_KEYED_NAME",
    "NINE_ROUTER_OPENAI_KEYED_PREFIX",
    "NINE_ROUTER_OPENROUTER_KEYED_NAME",
    "NINE_ROUTER_CUSTOM_NAME_SUFFIX",
    "ensure_running",
    "stop",
    "is_running",
    "get_usage_stats",
    "get_latest_reasoning_tokens",
    "get_providers",
    "get_models",
    "start_oauth",
    "poll_oauth",
    "exchange_oauth",
    "sync_gemini_api_key",
    "sync_openai_api_key",
    "sync_openrouter_api_key",
    "sync_custom_providers",
    "sync_openswarm_pro_as_claude",
    "normalize_openai_compat_base_url",
]
