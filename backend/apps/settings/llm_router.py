"""
LLM Router — routes LLM calls through direct Anthropic API or Claude Code CLI.

When an API key is configured, uses direct API calls (faster, lower latency).
When no API key is set, falls back to Claude Code CLI via claude_agent_sdk,
which uses the user's existing CLI authentication.
"""

import logging
import sys

from backend.apps.settings.settings import load_settings

logger = logging.getLogger(__name__)

MODEL_MAP = {
    "sonnet": "claude-sonnet-4-20250514",
    "opus": "claude-opus-4-20250514",
    "opus-1m": "claude-opus-4-6[1m]",
    "haiku": "claude-haiku-4-5-20251001",
}


def _resolve_model(short_name: str) -> str:
    return MODEL_MAP.get(short_name, short_name)


async def llm_call(
    system: str,
    user_message: str,
    model: str = "haiku",
    max_tokens: int = 100,
) -> str:
    """Make a one-shot LLM call, routing through API or CLI as appropriate.

    Returns the text response from the model.
    Raises on failure (callers should wrap in try/except if they have fallbacks).
    """
    settings = load_settings()
    if settings.anthropic_api_key:
        return await _api_call(settings.anthropic_api_key, system, user_message, model, max_tokens)
    return await _cli_call(system, user_message, model, max_tokens)


async def _api_call(
    api_key: str,
    system: str,
    user_message: str,
    model: str,
    max_tokens: int,
) -> str:
    import anthropic

    client = anthropic.AsyncAnthropic(api_key=api_key)
    resp = await client.messages.create(
        model=_resolve_model(model),
        max_tokens=max_tokens,
        system=system,
        messages=[{"role": "user", "content": user_message}],
    )
    return resp.content[0].text.strip()


async def _cli_call(
    system: str,
    user_message: str,
    model: str,
    max_tokens: int,
) -> str:
    from claude_agent_sdk import query, ClaudeAgentOptions
    from claude_agent_sdk.types import AssistantMessage, TextBlock

    options = ClaudeAgentOptions(
        model=model,
        system_prompt=system,
        max_turns=1,
        permission_mode="plan",  # no tool use, just text generation
        stderr=lambda line: None,  # suppress CLI startup noise
    )

    text_parts: list[str] = []
    async for message in query(prompt=user_message, options=options):
        if isinstance(message, AssistantMessage):
            for block in message.content:
                if isinstance(block, TextBlock):
                    text_parts.append(block.text)

    result = "".join(text_parts).strip()
    if not result:
        raise ValueError("CLI returned empty response")
    return result
