from backend.core.llm.resolve_sdk_env import resolve_sdk_env, SDK_ENV_DICT
from typing import Optional
from anthropic.types import Message as AnthropicMessage
import anthropic

async def quick_llm_call(
    system_prompt: str,
    user_prompt: str,
    model: str,
    max_tokens: int,
    api_key: Optional[str] = None,
    nine_router_port: Optional[int] = None,
) -> str:
    env_dict: SDK_ENV_DICT = resolve_sdk_env(api_key=api_key, nine_router_port=nine_router_port)
    client = anthropic.AsyncAnthropic(
        api_key=env_dict["ANTHROPIC_API_KEY"],
        base_url=env_dict.get("ANTHROPIC_BASE_URL"),
    )
    resp: AnthropicMessage = await client.messages.create(
        model=model,
        max_tokens=max_tokens,
        system=system_prompt,
        messages=[{"role": "user", "content": user_prompt}],
    )
    return resp.content[0].text.strip()