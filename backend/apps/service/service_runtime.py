"""Injected cross-app runtime boundary for the service SubApp."""

from __future__ import annotations

from typing import Any, Optional, Protocol, runtime_checkable

from backend.apps import nine_router
from backend.apps.agents import agent_manager as agents_runtime


@runtime_checkable
class RouterUsage(Protocol):
    """9Router lifecycle and usage-statistics operations the service app needs."""

    def is_running(self) -> bool: ...

    async def get_usage_stats(self, period: str = "all") -> Optional[dict]: ...

    async def ensure_running(self) -> None: ...

    def stop(self) -> None: ...


@runtime_checkable
class AgentCensus(Protocol):
    """Read-only views over live agent sessions for usage reporting."""

    def live_session_count(self) -> int: ...

    def all_sessions(self) -> list[Any]: ...


class DefaultRouterUsage:
    """Production adapter; dynamic lookups preserve established test seams."""

    def is_running(self) -> bool:
        return nine_router.is_running()

    async def get_usage_stats(self, period: str = "all") -> Optional[dict]:
        return await nine_router.get_usage_stats(period)

    async def ensure_running(self) -> None:
        await nine_router.ensure_running()

    def stop(self) -> None:
        nine_router.stop()


class DefaultAgentCensus:
    """Production adapter; dynamic lookups preserve established test seams."""

    def live_session_count(self) -> int:
        return len(agents_runtime.agent_manager.sessions)

    def all_sessions(self) -> list[Any]:
        return agents_runtime.agent_manager.get_all_sessions()


DEFAULT_ROUTER_USAGE: RouterUsage = DefaultRouterUsage()
DEFAULT_AGENT_CENSUS: AgentCensus = DefaultAgentCensus()
