"""Which subscriptions the app's router actually holds. The settings file still carries three
`*_subscription_token` fields that nothing has written since the OAuth flow moved into 9router, so
anything that answers "is a subscription connected?" from settings says no while the Settings page
says Connected (Chuya, 2026-09-04: the agent told her the Claude subscription serving her chat was
not connected). Every such answer reads from here."""

from __future__ import annotations

from typing import Optional

SUBSCRIPTION_LABELS = {"claude": "Claude Pro/Max", "codex": "ChatGPT Plus/Pro", "gemini-cli": "Gemini Advanced"}
ROUTER_UNKNOWN = "unknown (the app's router is not running)"


async def connected_subscription_providers() -> Optional[list[str]]:
    """Provider ids with a live user-owned subscription, or None when the router cannot say.
    None is not "none connected": a router that is down or mid-boot must never read as disconnected."""
    from backend.apps.nine_router import NINE_ROUTER_CLAUDE_PRO_NAME, get_providers, is_running

    if not is_running():
        return None
    try:
        conns = await get_providers()
    except Exception:
        return None
    seen: list[str] = []
    for c in conns:
        provider = c.get("provider")
        # The managed OpenSwarm Pro node registers as a `claude` connection; it is ours, not the user's.
        if c.get("isActive") and provider in SUBSCRIPTION_LABELS and c.get("name") != NINE_ROUTER_CLAUDE_PRO_NAME and provider not in seen:
            seen.append(provider)
    return seen


def subscription_labels(providers: Optional[list[str]]) -> list[str] | str:
    if providers is None:
        return ROUTER_UNKNOWN
    return [SUBSCRIPTION_LABELS[p] for p in providers if p in SUBSCRIPTION_LABELS]
