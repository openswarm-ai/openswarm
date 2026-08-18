"""Injected cross-app runtime boundary for the dashboards app."""

from __future__ import annotations

from typing import Any, Optional, Protocol, runtime_checkable

from backend.apps.agents import agent_manager as agents_runtime
from backend.apps.agents.core import aux_llm
from backend.apps.agents.manager.session import session_store
from backend.apps.agents.providers import registry
from backend.apps.service.analytics import client as analytics
from backend.apps.settings import credentials
from backend.apps.settings import settings as settings_app


@runtime_checkable
class DashboardTelemetry(Protocol):
    """Fire-and-forget analytics the dashboard routes emit."""

    def dashboard_event(self, *, dashboard_id: str, action: str) -> None: ...


@runtime_checkable
class SessionAuthority(Protocol):
    """Live/persisted agent-session operations the dashboard routes need."""

    def live_sessions(self) -> dict[str, Any]: ...

    def load_session_data(self, session_id: str) -> Optional[dict]: ...

    def save_session(self, session_id: str, data: dict) -> None: ...

    async def delete_session(self, session_id: str) -> None: ...

    async def duplicate_session(self, session_id: str, *, dashboard_id: str) -> Any: ...

    def purge_session_memory(self, session_id: str) -> None: ...


@runtime_checkable
class AuxNaming(Protocol):
    """Primitive lookups behind auto-naming; prompt/stream logic stays in dashboards.py."""

    def load_settings(self) -> Any: ...

    async def resolve_aux_model(self, settings: Any, *, preferred_tier: str) -> tuple[str, Any]: ...

    def client_for_model(self, settings: Any, model: str) -> Any: ...

    def clean_short_label(self, text: str) -> str: ...

    def aux_max_tokens_for(self, model: str) -> int: ...


class DefaultDashboardTelemetry:
    """Production adapter; dynamic lookups preserve established test seams."""

    def dashboard_event(self, *, dashboard_id: str, action: str) -> None:
        analytics.track_dashboard_event(dashboard_id=dashboard_id, action=action)


class DefaultSessionAuthority:
    """Production adapter; dynamic lookups preserve established test seams."""

    def live_sessions(self) -> dict[str, Any]:
        return agents_runtime.agent_manager.sessions

    def load_session_data(self, session_id: str) -> Optional[dict]:
        return session_store.load_session_data(session_id)

    def save_session(self, session_id: str, data: dict) -> None:
        session_store.save_session(session_id, data)

    async def delete_session(self, session_id: str) -> None:
        await agents_runtime.agent_manager.delete_session(session_id)

    async def duplicate_session(self, session_id: str, *, dashboard_id: str) -> Any:
        return await agents_runtime.agent_manager.duplicate_session(session_id, dashboard_id=dashboard_id)

    def purge_session_memory(self, session_id: str) -> None:
        agents_runtime.agent_manager.purge_session_memory(session_id)


class DefaultAuxNaming:
    """Production adapter; dynamic lookups preserve established test seams."""

    def load_settings(self) -> Any:
        return settings_app.load_settings()

    async def resolve_aux_model(self, settings: Any, *, preferred_tier: str) -> tuple[str, Any]:
        return await registry.resolve_aux_model(settings, preferred_tier=preferred_tier)

    def client_for_model(self, settings: Any, model: str) -> Any:
        return credentials.get_anthropic_client_for_model(settings, model)

    def clean_short_label(self, text: str) -> str:
        return aux_llm.clean_short_label(text)

    def aux_max_tokens_for(self, model: str) -> int:
        return aux_llm.aux_max_tokens_for(model)


DEFAULT_DASHBOARD_TELEMETRY: DashboardTelemetry = DefaultDashboardTelemetry()
DEFAULT_SESSION_AUTHORITY: SessionAuthority = DefaultSessionAuthority()
DEFAULT_AUX_NAMING: AuxNaming = DefaultAuxNaming()
