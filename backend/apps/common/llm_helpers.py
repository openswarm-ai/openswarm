"""Convenience wrappers for quick LLM calls.

These helpers handle client construction, markdown fence stripping, and JSON
parsing so that callers don't need to repeat the same boilerplate.
"""

from __future__ import annotations

import json
import logging
import re

logger = logging.getLogger(__name__)


def strip_markdown_fences(text: str) -> str:
    """Remove ```json ... ``` or similar fences from LLM output."""
    stripped = text.strip()
    if stripped.startswith("```"):
        stripped = re.sub(r"^```[a-zA-Z]*\n?", "", stripped, count=1)
        stripped = re.sub(r"\n?```\s*$", "", stripped)
    return stripped.strip()


def _resolve_model(model: str, settings) -> str:
    """Resolve short aliases and prefix with cc/ when routing through 9Router."""
    if settings.anthropic_api_key or model.startswith("cc/"):
        return model
    from backend.apps.nine_router import is_running as _9r_running
    if _9r_running():
        from backend.apps.common.model_registry import resolve_model_id
        resolved = resolve_model_id(model)
        return f"cc/{resolved}" if not resolved.startswith("cc/") else resolved
    return model


async def quick_llm_call(
    system: str,
    user_content: str,
    model: str = "claude-sonnet-4-20250514",
    max_tokens: int = 300,
) -> str:
    """Make a simple LLM call and return the text response."""
    from backend.apps.settings.credentials import get_anthropic_client
    from backend.apps.settings.settings import load_settings

    settings = load_settings()
    client = get_anthropic_client(settings)
    resolved_model = _resolve_model(model, settings)
    resp = await client.messages.create(
        model=resolved_model,
        max_tokens=max_tokens,
        system=system,
        messages=[{"role": "user", "content": user_content}],
    )
    return resp.content[0].text.strip()


async def quick_llm_json(
    system: str,
    user_content: str,
    model: str = "claude-sonnet-4-20250514",
    max_tokens: int = 300,
) -> dict:
    """Make an LLM call expecting JSON. Strips markdown fences, parses JSON."""
    raw = await quick_llm_call(system, user_content, model=model, max_tokens=max_tokens)
    cleaned = strip_markdown_fences(raw)
    return json.loads(cleaned)
