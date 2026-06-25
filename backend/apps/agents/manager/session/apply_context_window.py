"""Set a session's context_window from the provider registry for its (provider, model),
so the soft-cap trim, auto-compaction, and the UI percent meter line up with the model's
real cap (Opus/Sonnet 1M, Haiku 200k, custom per-provider). Silent fallback to the existing
value keeps a bad lookup from ever breaking a session."""

import logging
from typing import Optional

from typeguard import typechecked

from backend.apps.agents.core.models import AgentSession
from backend.apps.settings.models import AppSettings
from backend.apps.settings.settings import load_settings

logger = logging.getLogger(__name__)


@typechecked
def apply_context_window(session: AgentSession, settings: Optional[AppSettings] = None) -> None:
    """Called at every AgentSession creation, restore, and model-switch site."""
    try:
        from backend.apps.agents.providers.registry import get_context_window
        if settings is None:
            # Falling back to load_settings() inside the guard lets get_context_window still find a model-default cap when the settings file itself is unreadable.
            try:
                settings = load_settings()
            except Exception:
                settings = None
        cw = get_context_window(
            getattr(session, "provider", "") or "",
            getattr(session, "model", "") or "",
            settings,
        )
        if isinstance(cw, int) and cw > 0:
            session.context_window = cw
    except Exception:
        logger.debug("context_window lookup failed; keeping existing value", exc_info=True)
