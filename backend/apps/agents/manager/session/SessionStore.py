import asyncio
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, ConfigDict, Field
from typeguard import typechecked


class SessionStore(BaseModel):
    """Runtime-owned per-session maps for AgentManager; JSON persistence stays in session_store.py."""
    model_config = ConfigDict(validate_assignment=True, arbitrary_types_allowed=True)

    sessions: Dict[str, Any] = Field(default_factory=dict)
    tasks: Dict[str, Any] = Field(default_factory=dict)
    live_partial: Dict[str, Any] = Field(default_factory=dict)
    cancel_events: Dict[str, asyncio.Event] = Field(default_factory=dict)
    client_pool: Dict[str, Any] = Field(default_factory=dict)
    hook_ctxs: Dict[str, Any] = Field(default_factory=dict)
    stderr_buffers: Dict[str, List[str]] = Field(default_factory=dict)

    @typechecked
    def get_session(self, session_id: str) -> Optional[Any]:
        return self.sessions.get(session_id)

    @typechecked
    def set_session(self, session_id: str, session: Any) -> None:
        self.sessions[session_id] = session

    @typechecked
    def pop_session(self, session_id: str) -> Optional[Any]:
        return self.sessions.pop(session_id, None)

    @typechecked
    def has_session(self, session_id: str) -> bool:
        return session_id in self.sessions

    @typechecked
    def session_values(self) -> List[Any]:
        return list(self.sessions.values())

    @typechecked
    def session_items(self) -> List[tuple[str, Any]]:
        return list(self.sessions.items())

    @typechecked
    def get_task(self, session_id: str) -> Optional[Any]:
        return self.tasks.get(session_id)

    @typechecked
    def set_task(self, session_id: str, task: Any) -> None:
        self.tasks[session_id] = task

    @typechecked
    def pop_task(self, session_id: str) -> Optional[Any]:
        return self.tasks.pop(session_id, None)

    @typechecked
    def is_live_task(self, session_id: str, task: Any) -> bool:
        return self.tasks.get(session_id) is task

    @typechecked
    def set_live_partial(self, session_id: str, value: Any) -> None:
        self.live_partial[session_id] = value

    @typechecked
    def pop_live_partial(self, session_id: str) -> Optional[Any]:
        return self.live_partial.pop(session_id, None)

    @typechecked
    def get_or_create_stderr_buffer(self, session_id: str) -> List[str]:
        return self.stderr_buffers.setdefault(session_id, [])

    @typechecked
    def get_hook_ctx(self, session_id: str) -> Optional[Any]:
        return self.hook_ctxs.get(session_id)

    @typechecked
    def set_hook_ctx(self, session_id: str, hook_ctx: Any) -> None:
        self.hook_ctxs[session_id] = hook_ctx

    @typechecked
    def get_cancel_event(self, session_id: str) -> Optional[asyncio.Event]:
        return self.cancel_events.get(session_id)

    @typechecked
    def set_cancel_event(self, session_id: str, event: asyncio.Event) -> None:
        self.cancel_events[session_id] = event

    @typechecked
    def purge_session_runtime(self, session_id: str) -> None:
        self.sessions.pop(session_id, None)
        self.tasks.pop(session_id, None)
        self.live_partial.pop(session_id, None)
        self.cancel_events.pop(session_id, None)
        self.client_pool.pop(session_id, None)
        self.hook_ctxs.pop(session_id, None)
        self.stderr_buffers.pop(session_id, None)

    @typechecked
    def clear_sessions_and_tasks(self) -> None:
        self.sessions.clear()
        self.tasks.clear()
