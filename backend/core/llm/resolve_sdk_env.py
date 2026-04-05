import httpx
from typeguard import typechecked
from typing import Optional, Literal, Dict
from backend.core.generic_utils.assert_exactly_one_optional import assert_exactly_one_optional

@typechecked
def p_check_9router(nine_router_port: int) -> bool:
    try:
        r = httpx.get(f"http://localhost:{nine_router_port}/v1/models", timeout=2.0)
        return r.status_code == 200
    except Exception:
        return False

SDK_ENV_DICT = Dict[Literal["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"], str]

@typechecked
def resolve_sdk_env(
    api_key: Optional[str] = None,
    nine_router_port: Optional[int] = None,
) -> SDK_ENV_DICT:
    """Resolve credentials into an env dict for ClaudeAgentOptions."""
    assert_exactly_one_optional([api_key, nine_router_port])
    if api_key:
        return {"ANTHROPIC_API_KEY": api_key}
    elif nine_router_port:
        if not p_check_9router(nine_router_port):
            raise ValueError("9Router is not running. Set an API key or connect a subscription.")
        return {
            "ANTHROPIC_API_KEY": "9router",
            "ANTHROPIC_BASE_URL": f"http://localhost:{nine_router_port}",
        }
    else:
        raise ValueError("No AI provider configured. Set an API key or a 9router port")