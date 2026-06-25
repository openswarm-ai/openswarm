"""Typing-only contract shared by the AgentManager mixins.

The AgentManager god-object was decomposed into behavior mixins (Messaging,
SessionLifecycle, ...) that read state set in AgentManager.__init__ and call
methods implemented on sibling mixins. From inside one mixin a type checker can't
see that composed surface, so it flags self.sessions / self.run_agent_loop as
unknown. This base declares that surface (the __init__ state + the cross-mixin
methods) so each mixin inherits a typed view of the whole. It carries NO runtime
behavior: the attribute lines are bare annotations (lazy via __future__) and the
methods live in a TYPE_CHECKING block, so at runtime this is an empty class that
just sits once in the MRO. Re-enables the linter's pyright reportAttributeAccessIssue.
"""
from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Any, Dict

if TYPE_CHECKING:
    from backend.apps.agents.core.models import AgentSession
    from backend.apps.agents.manager.streaming.PartialReply import PartialReply


class AgentManagerProtocol:
    # State set in AgentManager.__init__.
    sessions: Dict[str, AgentSession]
    tasks: Dict[str, asyncio.Task]
    live_partial: Dict[str, PartialReply]
    cancel_events: Dict[str, asyncio.Event]

    if TYPE_CHECKING:
        # Methods implemented on sibling mixins / AgentManager itself and called cross-mixin. Loose signatures on purpose: typeCheckingMode is off, so this only has to assert the names exist, not pin their call shapes.
        def run_agent_loop(self, *args: Any, **kwargs: Any) -> Any: ...
        def generate_turn_label(self, *args: Any, **kwargs: Any) -> Any: ...
        def commit_partial_now(self, *args: Any, **kwargs: Any) -> Any: ...
        def stop_agent(self, *args: Any, **kwargs: Any) -> Any: ...
        def drain_task(self, *args: Any, **kwargs: Any) -> Any: ...
        def sync_session_close(self, *args: Any, **kwargs: Any) -> Any: ...
        def build_mcp_servers(self, *args: Any, **kwargs: Any) -> Any: ...
        def build_search_text(self, *args: Any, **kwargs: Any) -> Any: ...
        def stream_text(self, *args: Any, **kwargs: Any) -> Any: ...
        def stream_tool_input(self, *args: Any, **kwargs: Any) -> Any: ...
