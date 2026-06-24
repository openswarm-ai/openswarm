"""Which credential keeps a live agent session alive, as one typed value.

The settings-meta tool lets an agent edit its own Settings autonomously. The
single hard rule is "no suicide": it must never disconnect the credential that
powers its own run. We enforce that structurally, not with a scattered if-check,
by resolving the powering credential to a small closed value HERE, in one place,
and having the write guard key off it.

Add a provider lane and you add a case here; the exhaustive enumeration in
test_settings_meta_guard.py walks every (provider x route x connection_mode)
combo and fails until the new lane is classified, so a wrong/forgotten state
can't ship silently.

Honest scope: only API keys live in writable settings fields, so they're the
only credential the guard can be asked to protect. Subscriptions (OpenSwarm
Pro/free-trial, and the 9router OAuth lanes for Claude/Codex/Gemini) are either
server-owned or live entirely outside settings.json, so the settings-meta tool
cannot touch them at all, a stronger protection than the guard itself.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal, TYPE_CHECKING

from backend.apps.agents.providers.registry import (
    _CUSTOM_VALUE_PREFIX,
    custom_provider_slug_for_lookup,
    find_builtin_model,
    find_custom_provider_for_value,
    get_api_type,
)

if TYPE_CHECKING:
    from backend.apps.settings.models import AppSettings

# AppSettings fields holding a user-writable API key, keyed by provider api-type.
# Blanking whichever of these powers the current run is the one suicide the guard
# stops. Anything not here (subscription tokens, bearers) is not settings-writable.
P_API_KEY_FIELD_BY_API: dict[str, str] = {
    "anthropic": "anthropic_api_key",
    "openai": "openai_api_key",
    "codex": "openai_api_key",
    "gemini": "google_api_key",
    "openrouter": "openrouter_api_key",
}

# Every settings field that can hold an API key (the full guarded set). Custom
# providers keep their keys inside the custom_providers list, guarded separately.
ALL_API_KEY_FIELDS: frozenset[str] = frozenset(P_API_KEY_FIELD_BY_API.values())

CredentialKind = Literal["api_key", "subscription", "unknown"]


@dataclass(frozen=True)
class PoweringCredential:
    """The credential keeping THIS run alive, resolved to a closed value.

    kind=="api_key"      -> protected_field (or custom slug) names exactly what
                            the guard must keep alive.
    kind=="subscription" -> the live credential isn't a settings field at all
                            (Pro/free-trial/9router OAuth), so no api-key field
                            needs guarding; clearing OTHER keys stays allowed.
    kind=="unknown"      -> we couldn't classify the run; fail safe by treating
                            ALL credential fields as protected.
    """

    kind: CredentialKind
    provider: str
    protected_field: str | None = None
    protected_custom_slug: str | None = None
    label: str = ""


def p_custom_slug_for_model(model_value: str, settings: AppSettings) -> str | None:
    cp = find_custom_provider_for_value(settings, model_value)
    if cp is not None:
        return custom_provider_slug_for_lookup(getattr(cp, "name", ""))
    # Fall back to the slug encoded in the picker value itself.
    if isinstance(model_value, str) and model_value.startswith(_CUSTOM_VALUE_PREFIX):
        slug = model_value[len(_CUSTOM_VALUE_PREFIX):].partition("/")[0]
        return slug or None
    return None


def resolve_powering_credential(model_value: str, settings: AppSettings) -> PoweringCredential:
    """Resolve the credential powering a run on `model_value` to a typed value.

    `model_value` is the session's short model name (e.g. "opus-4-8", "sonnet-api",
    "custom/lmstudio/llama"), exactly what AgentSession.model holds.
    """
    entry = find_builtin_model(model_value)
    api = (entry or {}).get("api") or get_api_type(model_value)
    route = (entry or {}).get("route")
    mode = getattr(settings, "connection_mode", "own_key")

    # Custom provider (LM Studio, Ollama, Together, ...). Local servers use a
    # placeholder key, so suicide is removing the provider ENTRY, not blanking
    # its key; the guard keys off the slug.
    if api == "custom":
        slug = p_custom_slug_for_model(model_value, settings)
        return PoweringCredential(
            kind="api_key", provider="custom",
            protected_custom_slug=slug,
            label=f"custom provider '{slug}'" if slug else "custom provider",
        )

    # Explicit API-key route: the matching *_api_key field is the live one.
    if route == "api":
        field = P_API_KEY_FIELD_BY_API.get(api)
        if field:
            return PoweringCredential(kind="api_key", provider=api, protected_field=field,
                                      label=f"{field} (powers this run)")
        return PoweringCredential(kind="unknown", provider=api,
                                  label=f"{api} api route (unclassified)")

    # Subscription-only routes (cx/ Codex, gc/ Gemini CLI) and pinned cc/ Claude:
    # these lanes live in 9router, never in settings.
    if route == "cc" or (entry or {}).get("subscription_only"):
        return PoweringCredential(kind="subscription", provider=api,
                                  label=f"{api} subscription")

    # OpenRouter (its own `openrouter` route, plus xai/meta/deepseek/etc routed
    # through it): always an API key, never a subscription.
    if api == "openrouter":
        return PoweringCredential(kind="api_key", provider="openrouter",
                                  protected_field="openrouter_api_key",
                                  label="OpenRouter API key (powers this run)")

    # Default Anthropic rows (route is None): connection_mode picks the lane.
    if api == "anthropic":
        if mode in ("openswarm-pro", "free-trial"):
            label = "OpenSwarm Pro" if mode == "openswarm-pro" else "OpenSwarm free trial"
            return PoweringCredential(kind="subscription", provider="anthropic", label=label)
        if getattr(settings, "anthropic_api_key", None):
            return PoweringCredential(kind="api_key", provider="anthropic",
                                      protected_field="anthropic_api_key",
                                      label="Anthropic API key (powers this run)")
        # No key, no proxy mode -> the user's Claude subscription via 9router.
        return PoweringCredential(kind="subscription", provider="anthropic",
                                  label="Claude subscription")

    # Default Gemini rows (api gemini-cli, route None): the AG/gc OAuth lane is a
    # subscription. A bare AI Studio key only powers the explicit -api rows above.
    if api in ("gemini", "gemini-cli"):
        return PoweringCredential(kind="subscription", provider="gemini",
                                  label="Gemini subscription")

    # Anything we can't place: protect everything (fail safe), never fail open.
    return PoweringCredential(kind="unknown", provider=api or "unknown",
                              label=f"{api or 'unknown'} provider (unclassified)")


def p_is_blank(value: Any) -> bool:
    """A credential write that removes the credential: None, "", or whitespace."""
    if value is None:
        return True
    if isinstance(value, str):
        return value.strip() == ""
    return False


def p_powering_custom_slug_present(new_providers: Any, slug: str) -> bool:
    """True if the powering custom provider's entry still exists after the write."""
    if not isinstance(new_providers, list):
        return False
    for cp in new_providers:
        name = cp.get("name") if isinstance(cp, dict) else getattr(cp, "name", None)
        if name and custom_provider_slug_for_lookup(name) == slug:
            return True
    return False


def write_would_suicide(field: str, new_value: Any, powering: PoweringCredential) -> bool:
    """True if writing `new_value` to `field` would disconnect the live credential.

    Pure and total: every (field, value, powering) maps to a definite yes/no, so
    the guard can't be tricked by an unhandled path. Only blanking/removing a
    credential counts; SETTING a fresh key is a (re)connect, never suicide.
    """
    if field == "custom_providers":
        # Removing the entry that powers a custom-provider run is suicide; a
        # local provider's placeholder key being blanked is not. When the run is
        # unknown, any custom run could be the live one, so refuse a vanish.
        if powering.kind == "api_key" and powering.provider == "custom" and powering.protected_custom_slug:
            return not p_powering_custom_slug_present(new_value, powering.protected_custom_slug)
        if powering.kind == "unknown":
            return not p_powering_custom_slug_present(new_value, powering.protected_custom_slug or "")
        return False

    if field in ALL_API_KEY_FIELDS:
        if not p_is_blank(new_value):
            return False
        if powering.kind == "unknown":
            return True
        return powering.kind == "api_key" and field == powering.protected_field

    return False
