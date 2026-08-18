from datetime import datetime, timezone
from typing import Dict, Union

import pytest
from pydantic import ValidationError

from backend.apps.agents.events.AgentEvent import (
    ToolCompletedEvent,
    ToolStartedEvent,
    TurnCompletedEvent,
    TurnFailedEvent,
    TurnFirstTokenEvent,
    TurnStartedEvent,
    parse_agent_event,
)
from backend.apps.agents.events.AgentEventSink import (
    BoundedAgentEventSink,
    NullAgentEventSink,
    emit_agent_event,
)
from backend.apps.agents.events.AgentTurnEventEmitter import AgentTurnEventEmitter


def p_base() -> Dict[str, Union[str, int]]:
    return {
        "session_id": "session-1",
        "turn_id": "turn-1",
        "sequence": 3,
        "monotonic_ms": 1200,
    }


@pytest.mark.parametrize(
    "event",
    [
        TurnStartedEvent(**p_base(), provider="anthropic", model="claude"),
        TurnFirstTokenEvent(**p_base(), ttft_ms=320),
        ToolStartedEvent(**p_base(), tool_call_id="tool-1", tool_name="WebSearch"),
        ToolCompletedEvent(
            **p_base(),
            tool_call_id="tool-1",
            tool_name="WebSearch",
            duration_ms=40,
            status="success",
        ),
        TurnCompletedEvent(**p_base(), duration_ms=900, input_tokens=10, output_tokens=20),
        TurnFailedEvent(**p_base(), duration_ms=100, error_type="capacity", retryable=True),
    ],
)
def test_agent_event_round_trip(event):
    parsed = parse_agent_event(event.model_dump(mode="json"))
    assert type(parsed) is type(event)
    assert parsed.event_id == event.event_id


def test_event_identity_and_time_are_generated():
    first = TurnFirstTokenEvent(**p_base(), ttft_ms=1)
    second = TurnFirstTokenEvent(**p_base(), ttft_ms=1)
    assert first.event_id != second.event_id
    assert first.occurred_at.tzinfo == timezone.utc


def test_naive_occurrence_time_is_rejected():
    with pytest.raises(ValidationError):
        TurnFirstTokenEvent(**p_base(), ttft_ms=1, occurred_at=datetime(2026, 7, 11))


def test_discriminator_rejects_unknown_kind():
    with pytest.raises(ValidationError):
        parse_agent_event({**p_base(), "kind": "turn.unknown"})


def test_payload_bounds_reject_unbounded_tool_name():
    with pytest.raises(ValidationError):
        ToolStartedEvent(**p_base(), tool_call_id="tool-1", tool_name="x" * 129)


def test_extra_content_is_rejected():
    with pytest.raises(ValidationError):
        TurnCompletedEvent(**p_base(), duration_ms=1, prompt="secret")


def test_null_sink_accepts_event():
    event = TurnCompletedEvent(**p_base(), duration_ms=1)
    assert emit_agent_event(NullAgentEventSink(), event) is True


def test_sink_failure_is_isolated():
    class BrokenSink:
        def emit(self, event) -> None:
            raise RuntimeError("sink unavailable")

    event = TurnFailedEvent(**p_base(), duration_ms=1, error_type="test")
    assert emit_agent_event(BrokenSink(), event) is False


def test_bounded_sink_isolates_sessions_and_reports_eviction():
    sink = BoundedAgentEventSink(max_sessions=2, max_events_per_session=2)
    for sequence in range(3):
        sink.emit(TurnFirstTokenEvent(**{**p_base(), "sequence": sequence}, ttft_ms=sequence))
    sink.emit(TurnFirstTokenEvent(
        **{**p_base(), "session_id": "session-2"}, ttft_ms=1
    ))

    first = sink.snapshot("session-1")
    second = sink.snapshot("session-2")
    assert [event.sequence for event in first.events] == [1, 2]
    assert first.dropped_events == 1
    assert len(second.events) == 1


def test_bounded_sink_evicts_least_recently_emitted_session():
    sink = BoundedAgentEventSink(max_sessions=2, max_events_per_session=2)
    sink.emit(TurnFirstTokenEvent(**p_base(), ttft_ms=1))
    sink.emit(TurnFirstTokenEvent(**{**p_base(), "session_id": "session-2"}, ttft_ms=1))
    sink.emit(TurnFirstTokenEvent(**{**p_base(), "sequence": 4}, ttft_ms=1))
    sink.emit(TurnFirstTokenEvent(**{**p_base(), "session_id": "session-3"}, ttft_ms=1))

    assert sink.snapshot("session-1").events
    assert not sink.snapshot("session-2").events
    assert sink.snapshot("session-3").events


def test_production_manager_retains_events_but_isolated_managers_default_to_null():
    from backend.apps.agents.agent_manager import AgentManager, agent_manager

    assert isinstance(agent_manager.event_sink, BoundedAgentEventSink)
    assert isinstance(AgentManager().event_sink, NullAgentEventSink)


def test_emitter_first_token_and_tool_lifecycle_are_ordered_and_idempotent():
    sink = BoundedAgentEventSink()
    emitter = AgentTurnEventEmitter(
        sink=sink, session_id="session-1", provider="anthropic", model="claude"
    )

    emitter.emit_started()
    emitter.emit_first_token()
    emitter.emit_first_token()
    emitter.emit_tool_started("tool-1", "Read")
    emitter.emit_tool_started("tool-1", "Read")
    emitter.emit_tool_completed("tool-1", "Read")
    emitter.emit_completed()

    events = sink.snapshot("session-1").events
    assert [event.kind for event in events] == [
        "turn.started", "turn.first_token", "tool.started", "tool.completed", "turn.completed"
    ]
    assert [event.sequence for event in events] == list(range(5))
    assert len({event.turn_id for event in events}) == 1


def test_terminal_event_closes_unfinished_tools_without_raw_error_text():
    sink = BoundedAgentEventSink()
    emitter = AgentTurnEventEmitter(
        sink=sink, session_id="session-1", provider="anthropic", model="claude"
    )
    emitter.emit_started()
    emitter.emit_tool_started("tool-1", "Bash")
    emitter.emit_failed("RuntimeError")

    events = sink.snapshot("session-1").events
    assert [event.kind for event in events] == ["turn.started", "tool.started", "tool.completed", "turn.failed"]
    assert events[2].status == "error"
    assert events[2].error_type == "turn_ended"
