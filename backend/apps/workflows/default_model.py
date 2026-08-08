"""Which model a workflow runs on when nobody picked one.

`DEFAULT_MODEL` is `opus-5`, and that is Anthropic's API-KEY lane: the Claude subscription lane is a
separate id (`opus-5-cc`). Defaulting every workflow to the literal therefore billed an API key a
subscriber may not even have, and named a model a Codex or Gemini subscriber cannot run at all.
Lives in its own module because both the routes and the executor need it, and importing one from the
other is a cycle.
"""

import logging
from typing import Optional

from typeguard import typechecked

from backend.apps.settings.models import DEFAULT_MODEL

logger = logging.getLogger(__name__)


@typechecked
def user_default_model() -> str:
    """The model this user actually configured, never a vendor literal."""
    try:
        from backend.apps.settings.settings import load_settings
        chosen = (getattr(load_settings(), "default_model", "") or "").strip()
        return chosen or DEFAULT_MODEL
    except Exception:
        logger.debug("could not read the user's default model", exc_info=True)
        return DEFAULT_MODEL


@typechecked
def provider_for_model(model: Optional[str]) -> str:
    """Derive the provider from the model instead of assuming Anthropic."""
    if not model:
        return "anthropic"
    try:
        from backend.apps.agents.providers.registry import get_api_type
        return get_api_type(model) or "anthropic"
    except Exception:
        logger.debug("could not derive a provider for %s", model, exc_info=True)
        return "anthropic"
