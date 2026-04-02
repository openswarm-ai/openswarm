from typeguard import typechecked
from backend.ports import NINE_ROUTER_PORT
import anthropic
import httpx

SONNET: str = "claude-sonnet-4-6"
OPUS: str = "claude-opus-4-6"
HAIKU: str = "claude-haiku-4-5"

@typechecked
def is_valid_model_id(model_id: str) -> bool:
    return model_id in [SONNET, OPUS, HAIKU]

@typechecked
def check_9router() -> bool:
    """Check if 9Router is running locally."""
    try:
        response: httpx.Response = httpx.get(f"http://localhost:{NINE_ROUTER_PORT}/v1/models", timeout=2.0)
        return response.status_code == 200
    except Exception:
        return False

@typechecked
def get_anthropic_client() -> anthropic.AsyncAnthropic:
    if not check_9router():
        raise ValueError("9Router is not running")
    return anthropic.AsyncAnthropic(
        api_key="9router",
        base_url=f"http://localhost:{NINE_ROUTER_PORT}",
    )