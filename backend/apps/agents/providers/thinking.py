"""Thinking-level translation. Provider-agnostic off/low/medium/high/auto → per-API params."""

from __future__ import annotations


def thinking_params_for(api: str, level: str, model_id: str = "") -> dict | None:
    """Translate a provider-agnostic thinking level to per-provider API params.

    Args:
        api: "anthropic" | "codex" | "gemini-cli"
        level: "off" | "low" | "medium" | "high" | "auto"
        model_id: optional, used to pick adaptive vs legacy for Claude

    Returns a dict to merge into request params, or None for "use defaults".
    """
    if level == "auto":
        if api == "anthropic":
            return {"thinking": {"type": "adaptive"}}
        return None

    if level == "off":
        if api == "anthropic":
            return {"thinking": {"type": "disabled"}}
        if api == "codex":
            return {"reasoning": {"effort": "none"}}
        # Gemini: budget=0 actually disables reasoning. Anything else still
        # emits thoughtSignatures and 400s the next tool turn.
        if api == "gemini-cli":
            return {"thinkingConfig": {"thinkingBudget": 0}}
        return None

    if api == "anthropic":
        return {"thinking": {"type": "adaptive"}}

    if api == "codex":
        effort_map = {"low": "low", "medium": "medium", "high": "high"}
        return {"reasoning": {"effort": effort_map[level]}}

    if api == "gemini-cli":
        level_map = {"low": "LOW", "medium": "MEDIUM", "high": "HIGH"}
        return {"thinkingConfig": {"thinkingLevel": level_map[level]}}

    return None
