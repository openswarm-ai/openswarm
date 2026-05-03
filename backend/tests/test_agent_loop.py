"""Unit tests for `backend.apps.agents.agent_loop.AgentLoop`.

The agent loop is the provider-agnostic streaming + tool-use + HITL
core: it drives `BaseProvider.stream_message`, accumulates content
blocks, executes tools (with HITL gating), emits the WebSocket events
the frontend consumes, and persists the final messages.

The thinking-block path is already covered by `test_phase1_stress.py`.
This file focuses on the rest of the surface — the `run()` control
flow, `_execute_tools` (HITL deny / updated_input / executor errors /
truncation / multi-tool / non-tool skip), `_stream_and_collect`
JSON handling and stop_reason routing, `_emit_collected_messages`
formatting, and token-usage accumulation.

Pure unit tests: no FastAPI client, no network. We script provider
output via `_StubProvider` and capture WS emissions via `_WSRecorder`.
The conftest bootstrap (run automatically by virtue of living in
`backend/tests/`) redirects `OPENSWARM_DATA_DIR` and mocks PostHog so
nothing here ever touches the real disk or external services.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock

import pytest

from backend.apps.agents.agent_loop import AgentLoop
from backend.apps.agents.providers.base import (
    ContentBlock,
    ModelResponse,
    ProviderMessage,
    StreamEvent,
    ToolCall,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


class _StubProvider:
    """Scripted `BaseProvider` stand-in for the agent loop.

    Each call to `stream_message` consumes one entry from `turns` and
    yields its `StreamEvent`s in order. The messages list passed in is
    snapshotted into `self.calls[i]` so tests can assert on the
    conversation-history shape the agent loop sent on each turn.

    Duck-typed (not a `BaseProvider` subclass) — matches the
    convention in `test_phase1_stress.py` and avoids having to stub
    out `create_message` / `get_model_id` that the loop never calls.
    """

    def __init__(self, turns: list[list[StreamEvent]]):
        self._turns = list(turns)
        self.calls: list[list[ProviderMessage]] = []

    async def stream_message(
        self,
        *,
        model: str,
        system: str | None,
        messages: list[ProviderMessage],
        tools: list,
    ):
        # Snapshot at call time — the loop mutates `self.messages`
        # between turns, so a reference would get clobbered.
        self.calls.append(list(messages))
        if not self._turns:
            return
        for ev in self._turns.pop(0):
            yield ev

    def format_user_message(self, content: Any) -> ProviderMessage:
        return ProviderMessage(role="user", content=content)

    def format_assistant_message(self, response: ModelResponse) -> ProviderMessage:
        # Shape doesn't matter for these tests — the loop just appends
        # the message; we never feed it back through a real provider.
        return ProviderMessage(role="assistant", content=response.content)

    def format_tool_result(self, tool_use_id: str, content: list[dict]) -> dict:
        return {"type": "tool_result", "tool_use_id": tool_use_id, "content": content}


class _WSRecorder:
    """Async-callable that captures every (event, payload) pair the
    loop emits. Tests assert on `events` directly or via `of_type`."""

    def __init__(self):
        self.events: list[tuple[str, dict]] = []

    async def __call__(self, event_type: str, data: dict) -> None:
        self.events.append((event_type, data))

    def of_type(self, event_type: str) -> list[dict]:
        return [d for (e, d) in self.events if e == event_type]


# Block factories. A "block" is the start/delta/stop triple for one
# content_block in the model's output; a "turn" is one full
# stream_message call (one or more blocks + optional usage +
# message_stop).


def _text_block(text: str, *, index: int = 0) -> list[StreamEvent]:
    return [
        StreamEvent(type="content_block_start", index=index, block_type="text"),
        StreamEvent(
            type="content_block_delta",
            index=index,
            delta_type="text_delta",
            text=text,
        ),
        StreamEvent(type="content_block_stop", index=index),
    ]


def _tool_block(
    name: str,
    tool_id: str,
    json_input: str,
    *,
    index: int = 0,
) -> list[StreamEvent]:
    return [
        StreamEvent(
            type="content_block_start",
            index=index,
            block_type="tool_use",
            tool_name=name,
            tool_id=tool_id,
        ),
        StreamEvent(
            type="content_block_delta",
            index=index,
            delta_type="input_json_delta",
            text=json_input,
        ),
        StreamEvent(type="content_block_stop", index=index),
    ]


def _turn(
    *blocks: list[StreamEvent],
    usage: dict[str, int] | None = None,
) -> list[StreamEvent]:
    """Compose 1+ blocks into a complete turn (with usage + message_stop)."""
    events: list[StreamEvent] = []
    for block in blocks:
        events.extend(block)
    if usage:
        events.append(StreamEvent(type="usage", usage=usage))
    events.append(StreamEvent(type="message_stop"))
    return events


def _text_turn(text: str, *, usage: dict[str, int] | None = None) -> list[StreamEvent]:
    return _turn(_text_block(text), usage=usage)


def _tool_turn(
    name: str,
    tool_id: str,
    json_input: str,
    *,
    usage: dict[str, int] | None = None,
) -> list[StreamEvent]:
    return _turn(_tool_block(name, tool_id, json_input), usage=usage)


def _make_loop(
    *,
    provider: _StubProvider | None = None,
    executor=None,
    hitl=None,
    max_turns: int | None = None,
    system_prompt: str | None = None,
) -> tuple[AgentLoop, _WSRecorder]:
    """Build an `AgentLoop` plus its WS recorder. Sensible defaults
    for tests that don't care about a particular callback."""
    ws = _WSRecorder()
    loop = AgentLoop(
        session_id="test-session",
        provider=provider if provider is not None else _StubProvider([]),
        model="sonnet",
        system_prompt=system_prompt,
        tools=[],
        tool_executor=executor
        if executor is not None
        else AsyncMock(return_value=[{"type": "text", "text": "ok"}]),
        hitl_handler=hitl
        if hitl is not None
        else AsyncMock(return_value=(True, None)),
        ws_emitter=ws,
        max_turns=max_turns,
    )
    return loop, ws


# ---------------------------------------------------------------------------
# Group 1 — run() control flow
# ---------------------------------------------------------------------------


async def test_end_turn_exits_after_one_iteration():
    """No tool_use → loop calls the provider once and stops with
    [user, assistant] in history."""
    provider = _StubProvider([_text_turn("hello!")])
    loop, _ = _make_loop(provider=provider)

    await loop.run("hi")

    assert len(provider.calls) == 1
    assert [m.role for m in loop.messages] == ["user", "assistant"]


async def test_tool_use_continues_loop_then_terminates_on_end_turn():
    """tool_use → execute → second model call → end_turn. Verifies the
    full conversation grows to [user, assistant, tool_result, assistant]
    AND that turn 2 sees the prior tool_result."""
    provider = _StubProvider([
        _tool_turn("Read", "t1", '{"path": "/x"}'),
        _text_turn("done"),
    ])
    executor = AsyncMock(return_value=[{"type": "text", "text": "file contents"}])
    loop, _ = _make_loop(provider=provider, executor=executor)

    await loop.run("hi")

    assert len(provider.calls) == 2
    assert [m.role for m in loop.messages] == [
        "user", "assistant", "tool_result", "assistant",
    ]
    # The second model call must see the tool_result we appended.
    roles_seen_on_turn_2 = [m.role for m in provider.calls[1]]
    assert roles_seen_on_turn_2 == ["user", "assistant", "tool_result"]
    executor.assert_awaited_once()


async def test_max_turns_halts_loop_before_second_model_call():
    """`max_turns=1` allows exactly one model call + tool execution,
    then the top-of-loop guard breaks before turn 2. The unused
    second turn stays scripted but un-consumed."""
    provider = _StubProvider([
        _tool_turn("Read", "t1", "{}"),
        _tool_turn("Read", "t2", "{}"),  # would be consumed if guard failed
    ])
    executor = AsyncMock(return_value=[{"type": "text", "text": "ok"}])
    loop, _ = _make_loop(provider=provider, executor=executor, max_turns=1)

    await loop.run("hi")

    assert len(provider.calls) == 1, "max_turns=1 must cap provider calls"
    assert executor.await_count == 1, "tool exec runs in turn 1, not gated by max_turns"


async def test_no_tool_results_breaks_loop(monkeypatch):
    """Defensive guard: if `_execute_tools` returns `[]` for any
    reason, the loop must exit without appending an empty
    `tool_result` and without re-calling the provider."""
    provider = _StubProvider([
        _tool_turn("Read", "t1", "{}"),
        _text_turn("never reached"),
    ])
    loop, _ = _make_loop(provider=provider)

    async def _empty_results(self, response):
        return []

    monkeypatch.setattr(AgentLoop, "_execute_tools", _empty_results)

    await loop.run("hi")

    assert len(provider.calls) == 1
    assert [m.role for m in loop.messages] == ["user", "assistant"]


# ---------------------------------------------------------------------------
# Group 2 — _execute_tools
# ---------------------------------------------------------------------------


def _tool_use_response(*calls: tuple[str, str, dict]) -> ModelResponse:
    """Build a ModelResponse(stop_reason='tool_use') from (id, name, input) tuples."""
    return ModelResponse(
        content=[
            ContentBlock(
                type="tool_use",
                tool_call=ToolCall(id=tid, name=name, input=inp),
            )
            for (tid, name, inp) in calls
        ],
        stop_reason="tool_use",
    )


async def test_hitl_denial_skips_executor_and_returns_denial_text():
    executor = AsyncMock()
    hitl = AsyncMock(return_value=(False, None))
    loop, ws = _make_loop(executor=executor, hitl=hitl)

    response = _tool_use_response(("t1", "Read", {"path": "/x"}))
    results = await loop._execute_tools(response)

    executor.assert_not_called()
    assert len(results) == 1, "denied tools still produce a tool_result for the model"

    tool_result_msgs = [
        d["message"] for d in ws.of_type("agent:message")
        if d["message"]["role"] == "tool_result"
    ]
    assert len(tool_result_msgs) == 1
    assert tool_result_msgs[0]["content"]["text"] == "Tool use was denied by the user."
    assert tool_result_msgs[0]["content"]["tool_name"] == "Read"


async def test_hitl_updated_input_passed_to_executor():
    """When HITL approves with an `updated_input`, the executor must
    see that dict — not the model's original input."""
    executor = AsyncMock(return_value=[{"type": "text", "text": "ok"}])
    hitl = AsyncMock(return_value=(True, {"path": "/y"}))
    loop, _ = _make_loop(executor=executor, hitl=hitl)

    response = _tool_use_response(("t1", "Read", {"path": "/x"}))
    await loop._execute_tools(response)

    executor.assert_awaited_once_with("Read", {"path": "/y"})


async def test_executor_exception_is_caught_and_surfaced_as_error_text():
    async def boom(name, inp):
        raise RuntimeError("disk on fire")

    loop, ws = _make_loop(executor=boom)
    response = _tool_use_response(("t1", "Read", {}))

    results = await loop._execute_tools(response)

    # Loop survives, returns a formatted error result for the provider.
    assert len(results) == 1
    tool_results = [
        d["message"] for d in ws.of_type("agent:message")
        if d["message"]["role"] == "tool_result"
    ]
    assert tool_results[0]["content"]["text"] == "Error executing Read: disk on fire"


async def test_tool_result_text_truncated_to_15000_chars_in_emitted_message():
    """The model gets the full tool output; the WS message bubble
    that the UI renders is sliced to 15K to avoid jank."""
    huge = "x" * 20_000
    executor = AsyncMock(return_value=[{"type": "text", "text": huge}])
    loop, ws = _make_loop(executor=executor)

    response = _tool_use_response(("t1", "Read", {}))
    results = await loop._execute_tools(response)

    # WS-emitted snippet capped at 15K.
    tr_msg = next(
        d["message"] for d in ws.of_type("agent:message")
        if d["message"]["role"] == "tool_result"
    )
    assert len(tr_msg["content"]["text"]) == 15_000

    # Provider-bound result is the raw, untruncated content.
    assert results[0]["content"][0]["text"] == huge


async def test_multiple_tool_calls_in_one_response_all_execute():
    executor = AsyncMock(return_value=[{"type": "text", "text": "ok"}])
    loop, ws = _make_loop(executor=executor)

    response = _tool_use_response(
        ("t1", "Read", {"path": "/a"}),
        ("t2", "Edit", {"path": "/b"}),
    )
    results = await loop._execute_tools(response)

    assert executor.await_count == 2
    assert [r["tool_use_id"] for r in results] == ["t1", "t2"]
    tool_result_msgs = [
        d["message"] for d in ws.of_type("agent:message")
        if d["message"]["role"] == "tool_result"
    ]
    assert [m["content"]["tool_name"] for m in tool_result_msgs] == ["Read", "Edit"]


async def test_non_tool_use_blocks_are_skipped_in_executor():
    """A response with text + tool_use should only execute the tool block."""
    executor = AsyncMock(return_value=[{"type": "text", "text": "ok"}])
    loop, _ = _make_loop(executor=executor)

    response = ModelResponse(
        content=[
            ContentBlock(type="text", text="thinking aloud"),
            ContentBlock(
                type="tool_use",
                tool_call=ToolCall(id="t1", name="Read", input={}),
            ),
        ],
        stop_reason="tool_use",
    )

    results = await loop._execute_tools(response)
    assert len(results) == 1
    executor.assert_awaited_once()


# ---------------------------------------------------------------------------
# Group 3 — _stream_and_collect
# ---------------------------------------------------------------------------


async def test_invalid_tool_input_json_falls_back_to_empty_dict():
    """Malformed JSON in input_json_delta must not crash; the
    resulting ToolCall.input is `{}`."""
    provider = _StubProvider([_tool_turn("Read", "t1", "{not valid json")])
    loop, _ = _make_loop(provider=provider)

    response = await loop._stream_and_collect()

    tool_blocks = [b for b in response.content if b.type == "tool_use"]
    assert len(tool_blocks) == 1
    assert tool_blocks[0].tool_call is not None
    assert tool_blocks[0].tool_call.input == {}


async def test_tool_use_input_assembled_from_multiple_json_deltas():
    """Real Anthropic streams ship tool input in multiple
    input_json_delta chunks — they must concatenate into one JSON
    parse."""
    provider = _StubProvider([[
        StreamEvent(
            type="content_block_start", index=0, block_type="tool_use",
            tool_name="Read", tool_id="t1",
        ),
        StreamEvent(
            type="content_block_delta", index=0,
            delta_type="input_json_delta", text='{"pa',
        ),
        StreamEvent(
            type="content_block_delta", index=0,
            delta_type="input_json_delta", text='th": "/x", "n": 7}',
        ),
        StreamEvent(type="content_block_stop", index=0),
        StreamEvent(type="message_stop"),
    ]])
    loop, _ = _make_loop(provider=provider)

    response = await loop._stream_and_collect()

    assert response.content[0].tool_call.input == {"path": "/x", "n": 7}


async def test_stop_reason_routes_on_presence_of_tool_use_block():
    """`response.stop_reason` is `"tool_use"` iff any collected
    block is tool_use, else `"end_turn"`."""
    text_provider = _StubProvider([_text_turn("hi")])
    loop1, _ = _make_loop(provider=text_provider)
    resp_text = await loop1._stream_and_collect()
    assert resp_text.stop_reason == "end_turn"

    tool_provider = _StubProvider([_tool_turn("Read", "t1", "{}")])
    loop2, _ = _make_loop(provider=tool_provider)
    resp_tool = await loop2._stream_and_collect()
    assert resp_tool.stop_reason == "tool_use"


# ---------------------------------------------------------------------------
# Group 3b — _stream_and_collect WS emissions
# ---------------------------------------------------------------------------
# Thinking-block WS emissions are covered in `test_phase1_stress.py`. The
# tests below cover the text and tool_use streaming paths plus the
# routing rule that determines WHERE `agent:stream_end` fires for each
# block type — text waits for `message_stop`, tool_use/thinking close at
# `content_block_stop`.


async def test_text_block_streams_deltas_and_ends_at_message_stop():
    """Text block emits one stream_start (role=assistant), one
    stream_delta per text_delta event (carrying the same message_id),
    and one stream_end deferred to `message_stop` — NOT to
    `content_block_stop`."""
    provider = _StubProvider([[
        StreamEvent(type="content_block_start", index=0, block_type="text"),
        StreamEvent(
            type="content_block_delta", index=0,
            delta_type="text_delta", text="hel",
        ),
        StreamEvent(
            type="content_block_delta", index=0,
            delta_type="text_delta", text="lo",
        ),
        StreamEvent(type="content_block_stop", index=0),
        StreamEvent(type="message_stop"),
    ]])
    loop, ws = _make_loop(provider=provider)

    await loop._stream_and_collect()

    starts = ws.of_type("agent:stream_start")
    assert len(starts) == 1
    assert starts[0]["role"] == "assistant"
    text_msg_id = starts[0]["message_id"]

    deltas = ws.of_type("agent:stream_delta")
    assert [d["delta"] for d in deltas] == ["hel", "lo"]
    assert all(d["message_id"] == text_msg_id for d in deltas)

    ends = ws.of_type("agent:stream_end")
    assert len(ends) == 1
    assert ends[0] == {"message_id": text_msg_id}

    # Stream-end placement: text's stream_end must come AFTER the
    # content_block_stop has already been processed — i.e. it's tied
    # to message_stop. Concretely, no agent:stream_delta or new
    # agent:stream_start can follow it for this same message_id.
    types_in_order = [e for (e, _) in ws.events]
    end_idx = types_in_order.index("agent:stream_end")
    assert "agent:stream_delta" not in types_in_order[end_idx + 1:]


async def test_tool_use_block_streams_deltas_and_ends_at_block_stop():
    """Tool_use block emits stream_start (role=tool_call, tool_name),
    one stream_delta per input_json_delta, and stream_end at
    `content_block_stop` so the UI can finalize the tool-call bubble
    before any subsequent text streams in."""
    provider = _StubProvider([[
        StreamEvent(
            type="content_block_start", index=0, block_type="tool_use",
            tool_name="Read", tool_id="t1",
        ),
        StreamEvent(
            type="content_block_delta", index=0,
            delta_type="input_json_delta", text='{"path"',
        ),
        StreamEvent(
            type="content_block_delta", index=0,
            delta_type="input_json_delta", text=': "/x"}',
        ),
        StreamEvent(type="content_block_stop", index=0),
        StreamEvent(type="message_stop"),
    ]])
    loop, ws = _make_loop(provider=provider)

    await loop._stream_and_collect()

    starts = ws.of_type("agent:stream_start")
    assert len(starts) == 1
    assert starts[0]["role"] == "tool_call"
    assert starts[0]["tool_name"] == "Read"
    tool_msg_id = starts[0]["message_id"]

    deltas = ws.of_type("agent:stream_delta")
    assert [d["delta"] for d in deltas] == ['{"path"', ': "/x"}']
    assert all(d["message_id"] == tool_msg_id for d in deltas)

    ends = ws.of_type("agent:stream_end")
    assert len(ends) == 1
    assert ends[0]["message_id"] == tool_msg_id

    # tool_use stream_end fires at content_block_stop — i.e. BEFORE
    # the message_stop housekeeping. Verify there's no subsequent
    # delta/end for this id and that an agent:message (the persisted
    # tool_call bubble) follows in `_emit_collected_messages`.
    types_in_order = [e for (e, _) in ws.events]
    stop_idx = types_in_order.index("agent:stream_end")
    assert "agent:stream_delta" not in types_in_order[stop_idx + 1:]
    assert "agent:message" in types_in_order[stop_idx + 1:], (
        "the persisted tool_call message must be emitted after stream_end"
    )


# ---------------------------------------------------------------------------
# Group 4 — _emit_collected_messages
# ---------------------------------------------------------------------------


async def test_text_blocks_joined_with_single_newline_and_msg_id_preserved():
    """Multiple text blocks → one assistant Message whose `id` is the
    streamed msg_id (so the client can dedupe its optimistic bubble)."""
    loop, ws = _make_loop()
    content = [
        ContentBlock(type="text", text="line A"),
        ContentBlock(type="text", text="line B"),
        ContentBlock(type="text", text=""),  # empty blocks dropped
    ]

    await loop._emit_collected_messages(
        content, text_msg_id="text-id-123", tool_msg_ids={},
    )

    assistants = [
        d["message"] for d in ws.of_type("agent:message")
        if d["message"]["role"] == "assistant"
    ]
    assert len(assistants) == 1
    assert assistants[0]["content"] == "line A\nline B"
    assert assistants[0]["id"] == "text-id-123"


async def test_thinking_blocks_joined_with_double_newline_and_metadata():
    """Multiple thinking blocks → one persisted thinking Message
    joined by `\\n\\n`. `elapsed_ms` and `tokens` are derived from
    the server-stamped accumulators."""
    loop, ws = _make_loop()
    content = [
        ContentBlock(type="thinking", text="step one"),
        ContentBlock(type="thinking", text="step two"),
        ContentBlock(type="text", text="answer"),
    ]

    await loop._emit_collected_messages(
        content,
        text_msg_id="t1",
        tool_msg_ids={},
        thinking_elapsed_ms=1234,
        thinking_total_chars=20,
    )

    msgs = [d["message"] for d in ws.of_type("agent:message")]
    thinking = [m for m in msgs if m["role"] == "thinking"]
    assert len(thinking) == 1
    assert thinking[0]["content"] == "step one\n\nstep two"
    assert thinking[0]["elapsed_ms"] == 1234
    assert thinking[0]["tokens"] == max(1, round(20 / 3.6))


async def test_thinking_message_omits_tokens_and_elapsed_when_zero():
    """`thinking_elapsed_ms=0` → `elapsed_ms=None`, and
    `thinking_total_chars=0` → `tokens=None`. Matches the
    `... or None` / `if thinking_total_chars` guards."""
    loop, ws = _make_loop()
    content = [ContentBlock(type="thinking", text="thoughts")]

    await loop._emit_collected_messages(
        content,
        text_msg_id=None,
        tool_msg_ids={},
        thinking_elapsed_ms=0,
        thinking_total_chars=0,
    )

    thinking = next(
        d["message"] for d in ws.of_type("agent:message")
        if d["message"]["role"] == "thinking"
    )
    assert thinking["elapsed_ms"] is None
    assert thinking["tokens"] is None


async def test_tool_call_messages_use_stream_msg_ids_in_index_order():
    """`tool_msg_ids` is keyed by stream block index. Emission must
    sort by index so the first emitted tool_call gets the id from
    index 0, even if the dict was inserted out of order."""
    loop, ws = _make_loop()
    content = [
        ContentBlock(
            type="tool_use",
            tool_call=ToolCall(id="t1", name="Read", input={"x": 1}),
        ),
        ContentBlock(
            type="tool_use",
            tool_call=ToolCall(id="t2", name="Edit", input={"y": 2}),
        ),
    ]

    # Insert higher index first to guard against accidental
    # insertion-order semantics in the future.
    await loop._emit_collected_messages(
        content,
        text_msg_id=None,
        tool_msg_ids={1: "ID-B", 0: "ID-A"},
    )

    tool_calls = [
        d["message"] for d in ws.of_type("agent:message")
        if d["message"]["role"] == "tool_call"
    ]
    assert [m["id"] for m in tool_calls] == ["ID-A", "ID-B"]
    assert tool_calls[0]["content"] == {"id": "t1", "tool": "Read", "input": {"x": 1}}
    assert tool_calls[1]["content"] == {"id": "t2", "tool": "Edit", "input": {"y": 2}}


# ---------------------------------------------------------------------------
# Group 5 — usage tracking
# ---------------------------------------------------------------------------


async def test_token_usage_accumulates_across_turns():
    """Per-turn `usage` events must sum into `total_input_tokens` /
    `total_output_tokens` over the whole `run()`."""
    provider = _StubProvider([
        _tool_turn(
            "Read", "t1", "{}",
            usage={"input_tokens": 100, "output_tokens": 50},
        ),
        _text_turn(
            "done",
            usage={"input_tokens": 30, "output_tokens": 20},
        ),
    ])
    loop, _ = _make_loop(provider=provider)

    await loop.run("hi")

    assert loop.total_input_tokens == 130
    assert loop.total_output_tokens == 70
