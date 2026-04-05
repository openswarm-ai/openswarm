from backend.core.llm.get_llm_client import get_llm_client
from typing import Optional
from anthropic.types import Message as AnthropicMessage

async def quick_llm_call(
    system: str,
    user_content: str,
    model: str,
    max_tokens: int,
    api_key: Optional[str] = None,
    nine_router_port: Optional[int] = None,
) -> str:
    client = get_llm_client(api_key=api_key, nine_router_port=nine_router_port)
    resp: AnthropicMessage = await client.messages.create(
        model=model,
        max_tokens=max_tokens,
        system=system,
        messages=[{"role": "user", "content": user_content}],
    )
    return resp.content[0].text.strip()