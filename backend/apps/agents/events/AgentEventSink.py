from __future__ import annotations

import logging
from collections import OrderedDict, deque
from dataclasses import dataclass
from threading import Lock
from typing import Dict, Protocol, Tuple, runtime_checkable

from pydantic import BaseModel, ConfigDict
from typeguard import typechecked

from backend.apps.agents.events.AgentEvent import AgentEvent

logger = logging.getLogger(__name__)


@runtime_checkable
class AgentEventSink(Protocol):
    @typechecked
    def emit(self, event: AgentEvent) -> None:
        ...


class NullAgentEventSink(BaseModel):
    model_config = ConfigDict(validate_assignment=True)

    @typechecked
    def emit(self, event: AgentEvent) -> None:
        return None


@dataclass(frozen=True)
class AgentEventSnapshot:
    session_id: str
    events: Tuple[AgentEvent, ...]
    dropped_events: int


class BoundedAgentEventSink:
    """Thread-safe per-session event history for debug timeline adapters."""

    @typechecked
    def __init__(self, max_sessions: int = 64, max_events_per_session: int = 512) -> None:
        if max_sessions < 1 or max_events_per_session < 1:
            raise ValueError("event sink bounds must be at least 1")
        self.max_sessions = max_sessions
        self.max_events_per_session = max_events_per_session
        self.p_events: OrderedDict[str, deque[AgentEvent]] = OrderedDict()
        self.p_dropped: Dict[str, int] = {}
        self.p_lock = Lock()

    @typechecked
    def emit(self, event: AgentEvent) -> None:
        with self.p_lock:
            session_events = self.p_events.get(event.session_id)
            if session_events is None:
                if len(self.p_events) >= self.max_sessions:
                    evicted_session, _ = self.p_events.popitem(last=False)
                    self.p_dropped.pop(evicted_session, None)
                session_events = deque(maxlen=self.max_events_per_session)
                self.p_events[event.session_id] = session_events
                self.p_dropped[event.session_id] = 0
            else:
                self.p_events.move_to_end(event.session_id)
            if len(session_events) == self.max_events_per_session:
                self.p_dropped[event.session_id] += 1
            session_events.append(event)

    @typechecked
    def snapshot(self, session_id: str) -> AgentEventSnapshot:
        with self.p_lock:
            return AgentEventSnapshot(
                session_id=session_id,
                events=tuple(self.p_events.get(session_id, ())),
                dropped_events=self.p_dropped.get(session_id, 0),
            )

    @typechecked
    def clear(self, session_id: str | None = None) -> None:
        with self.p_lock:
            if session_id is None:
                self.p_events.clear()
                self.p_dropped.clear()
                return
            self.p_events.pop(session_id, None)
            self.p_dropped.pop(session_id, None)


@typechecked
def emit_agent_event(sink: AgentEventSink, event: AgentEvent) -> bool:
    try:
        sink.emit(event)
        return True
    except Exception:
        logger.debug("agent event sink failed", exc_info=True)
        return False
