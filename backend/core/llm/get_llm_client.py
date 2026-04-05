import anthropic
import httpx
from typeguard import typechecked
from typing import Optional
from backend.core.generic_utils.assert_exactly_one_optional import assert_exactly_one_optional

@typechecked
def p_check_9router(nine_router_port: int) -> bool:
    try:
        r = httpx.get(f"http://localhost:{nine_router_port}/v1/models", timeout=2.0)
        return r.status_code == 200
    except Exception:
        return False


@typechecked
def get_llm_client(
    api_key: Optional[str] = None,
    nine_router_port: Optional[int] = None,
) -> anthropic.AsyncAnthropic:
    """Build an AsyncAnthropic client.

    Priority: API key → 9Router subscription
    """
    assert_exactly_one_optional([api_key, nine_router_port])
    
    if api_key is not None:
        return anthropic.AsyncAnthropic(api_key=api_key)
    
    elif nine_router_port is not None:
        if not p_check_9router(nine_router_port):
            raise ValueError("9Router is not running. Set an API key or connect a subscription.")
        return anthropic.AsyncAnthropic(
            api_key="9router",
            base_url=f"http://localhost:{nine_router_port}",
        )
    
    else:
        raise ValueError("No AI provider configured. Set an API key or a 9Router port.")
