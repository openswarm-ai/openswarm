"""Tests for the uncovered branches of the Anthropic provider adapter.

`test_phase1_stress.py::test_anthropic_provider_forwards_thinking_blocks`
already covers the streaming-thinking path. This file fills in the
remaining branches: model id mapping, message-format helpers,
non-streaming `create_message`, `_build_messages` (tool_result list
vs. single-dict shape), and the `message_start` / `message_delta`
usage-extraction code in `stream_message`.

The Anthropic SDK client is fully mocked — no network, no API key
required.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from backend.apps.agents.providers.anthropic import AnthropicProvider, MODEL_MAP
from backend.apps.agents.providers.base import (
    ContentBlock,
    ModelResponse,
    ProviderMessage,
    ToolCall,
    ToolSchema,
)


# ---------------------------------------------------------------------------
# Lightweight fakes (mimics the SDK's duck-typed objects without pulling
# in the real anthropic types — they're a heavy import path).
# ---------------------------------------------------------------------------


class _FakeAttr:
    """Generic dot-attribute object for SDK-shaped responses."""

    def __init__(self, **kwargs: Any) -> None:
        for k, v in kwargs.items():
            setattr(self, k, v)


def _make_provider() -> AnthropicProvider:
    """Build a provider whose underlying SDK client is fully mocked."""
    p = AnthropicProvider(api_key="test-key")
    # Replace the AsyncAnthropic client wholesale; tests will set the
    # specific behaviour on `client.messages.create`.
    p.client = MagicMock()
    p.client.messages = MagicMock()
    p.client.messages.create = AsyncMock()
    return p


# ---------------------------------------------------------------------------
# get_model_id
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("short,full", list(MODEL_MAP.items()))
def test_get_model_id_short_name_resolves_to_full(short: str, full: str):
    p = _make_provider()
    assert p.get_model_id(short) == full


def test_get_model_id_passthrough_for_unknown():
    """Anything not in MODEL_MAP is returned verbatim."""
    p = _make_provider()
    assert p.get_model_id("claude-7-sonnet-20991231") == "claude-7-sonnet-20991231"


# ---------------------------------------------------------------------------
# format_user_message / format_assistant_message / format_tool_result
# ---------------------------------------------------------------------------


def test_format_user_message_string_content():
    p = _make_provider()
    msg = p.format_user_message("hello")
    assert isinstance(msg, ProviderMessage)
    assert msg.role == "user"
    assert msg.content == "hello"


def test_format_user_message_multimodal_blocks():
    """Image + text user message — content list should pass through unchanged."""
    p = _make_provider()
    blocks = [
        {"type": "text", "text": "look at this"},
        {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "AA=="}},
    ]
    msg = p.format_user_message(blocks)
    assert msg.role == "user"
    assert msg.content is blocks


def test_format_assistant_message_text_only():
    p = _make_provider()
    resp = ModelResponse(
        content=[ContentBlock(type="text", text="hello")],
        stop_reason="end_turn",
    )
    msg = p.format_assistant_message(resp)
    assert msg.role == "assistant"
    assert msg.content == [{"type": "text", "text": "hello"}]


def test_format_assistant_message_mixed_text_and_tool_use():
    """ContentBlocks of type=text/tool_use must round-trip into the
    Anthropic message-content shape, preserving id+name+input."""
    p = _make_provider()
    resp = ModelResponse(
        content=[
            ContentBlock(type="text", text="thinking…"),
            ContentBlock(
                type="tool_use",
                tool_call=ToolCall(id="t1", name="Read", input={"path": "/tmp/x"}),
            ),
            ContentBlock(type="text", text="done"),
        ],
        stop_reason="tool_use",
    )
    msg = p.format_assistant_message(resp)
    assert msg.role == "assistant"
    assert msg.content == [
        {"type": "text", "text": "thinking…"},
        {"type": "tool_use", "id": "t1", "name": "Read", "input": {"path": "/tmp/x"}},
        {"type": "text", "text": "done"},
    ]


def test_format_assistant_message_skips_tool_use_without_call():
    """A tool_use block with no ToolCall is dropped (defensive — should
    never happen in practice, but the conditional is in the source)."""
    p = _make_provider()
    resp = ModelResponse(
        content=[
            ContentBlock(type="text", text="hi"),
            ContentBlock(type="tool_use", tool_call=None),  # silently dropped
        ],
        stop_reason="end_turn",
    )
    msg = p.format_assistant_message(resp)
    assert msg.content == [{"type": "text", "text": "hi"}]


def test_format_tool_result_shape():
    p = _make_provider()
    out = p.format_tool_result(
        "tool-id-7",
        [{"type": "text", "text": "result body"}],
    )
    assert out == {
        "type": "tool_result",
        "tool_use_id": "tool-id-7",
        "content": [{"type": "text", "text": "result body"}],
    }


# ---------------------------------------------------------------------------
# clean_tool_schema
# ---------------------------------------------------------------------------


def test_clean_tool_schema_returns_anthropic_format():
    p = _make_provider()
    schema = ToolSchema(
        name="Read",
        description="Read a file",
        input_schema={"type": "object", "properties": {"path": {"type": "string"}}},
    )
    out = p.clean_tool_schema(schema)
    assert out == {
        "name": "Read",
        "description": "Read a file",
        "input_schema": {"type": "object", "properties": {"path": {"type": "string"}}},
    }


# ---------------------------------------------------------------------------
# _build_messages — every role + tool_result list/non-list shape
# ---------------------------------------------------------------------------


def test_build_messages_passes_through_user_and_assistant():
    p = _make_provider()
    msgs = [
        ProviderMessage(role="user", content="hi"),
        ProviderMessage(role="assistant", content=[{"type": "text", "text": "hello"}]),
    ]
    built = p._build_messages(msgs)
    assert built == [
        {"role": "user", "content": "hi"},
        {"role": "assistant", "content": [{"type": "text", "text": "hello"}]},
    ]


def test_build_messages_tool_result_list_passes_unwrapped():
    """Tool results delivered as a list of result blocks must be sent
    as-is under role=user."""
    p = _make_provider()
    blocks = [
        {"type": "tool_result", "tool_use_id": "t1", "content": [{"type": "text", "text": "ok"}]},
        {"type": "tool_result", "tool_use_id": "t2", "content": [{"type": "text", "text": "ok2"}]},
    ]
    built = p._build_messages([ProviderMessage(role="tool_result", content=blocks)])
    assert built == [{"role": "user", "content": blocks}]


def test_build_messages_tool_result_single_dict_gets_wrapped_in_list():
    """A non-list tool_result content must be wrapped: the API expects
    `content` to always be a list at this level."""
    p = _make_provider()
    block = {"type": "tool_result", "tool_use_id": "t1", "content": "ok"}
    built = p._build_messages([ProviderMessage(role="tool_result", content=block)])
    assert built == [{"role": "user", "content": [block]}]


def test_build_messages_drops_unknown_role():
    """If somehow a ProviderMessage with role='something_weird' is
    passed in, the loop must skip it rather than crash."""
    p = _make_provider()
    built = p._build_messages([
        ProviderMessage(role="weird", content="x"),
        ProviderMessage(role="user", content="hi"),
    ])
    assert built == [{"role": "user", "content": "hi"}]


# ---------------------------------------------------------------------------
# create_message (non-streaming)
# ---------------------------------------------------------------------------


async def test_create_message_returns_normalized_response_text_only():
    p = _make_provider()
    fake_resp = _FakeAttr(
        content=[_FakeAttr(type="text", text="hello world")],
        stop_reason="end_turn",
        usage=_FakeAttr(input_tokens=42, output_tokens=7),
    )
    p.client.messages.create = AsyncMock(return_value=fake_resp)

    out = await p.create_message(
        model="sonnet",
        system="be useful",
        messages=[ProviderMessage(role="user", content="hi")],
        tools=[],
    )

    # Kwargs were translated through get_model_id + clean_tool_schema
    args, kwargs = p.client.messages.create.call_args
    assert kwargs["model"] == MODEL_MAP["sonnet"]
    assert kwargs["max_tokens"] == 8192
    assert kwargs["system"] == "be useful"
    assert kwargs["messages"] == [{"role": "user", "content": "hi"}]
    assert "tools" not in kwargs  # empty list = omit

    assert isinstance(out, ModelResponse)
    assert out.stop_reason == "end_turn"
    assert out.usage == {"input_tokens": 42, "output_tokens": 7}
    assert len(out.content) == 1
    assert out.content[0].type == "text"
    assert out.content[0].text == "hello world"


async def test_create_message_translates_tool_use_block():
    p = _make_provider()
    fake_resp = _FakeAttr(
        content=[
            _FakeAttr(type="text", text="let me check"),
            _FakeAttr(
                type="tool_use",
                id="toolu_1",
                name="Read",
                input={"path": "/tmp/x"},
            ),
        ],
        stop_reason="tool_use",
        usage=_FakeAttr(input_tokens=10, output_tokens=2),
    )
    p.client.messages.create = AsyncMock(return_value=fake_resp)

    out = await p.create_message(
        model="opus",
        system=None,
        messages=[ProviderMessage(role="user", content="x")],
        tools=[
            ToolSchema(name="Read", description="Read a file",
                       input_schema={"type": "object"}),
        ],
    )

    _, kwargs = p.client.messages.create.call_args
    assert kwargs["model"] == MODEL_MAP["opus"]
    assert kwargs["tools"] == [{
        "name": "Read", "description": "Read a file",
        "input_schema": {"type": "object"},
    }]
    assert "system" not in kwargs  # None is dropped

    assert out.stop_reason == "tool_use"
    assert out.content[0].type == "text"
    assert out.content[1].type == "tool_use"
    assert out.content[1].tool_call is not None
    assert out.content[1].tool_call.id == "toolu_1"
    assert out.content[1].tool_call.name == "Read"
    assert out.content[1].tool_call.input == {"path": "/tmp/x"}


async def test_create_message_max_tokens_passthrough():
    p = _make_provider()
    p.client.messages.create = AsyncMock(return_value=_FakeAttr(
        content=[_FakeAttr(type="text", text="ok")],
        stop_reason="end_turn",
        usage=_FakeAttr(input_tokens=1, output_tokens=1),
    ))
    await p.create_message(
        model="sonnet", system=None,
        messages=[ProviderMessage(role="user", content="x")],
        tools=[], max_tokens=12_345,
    )
    _, kwargs = p.client.messages.create.call_args
    assert kwargs["max_tokens"] == 12_345


# ---------------------------------------------------------------------------
# stream_message: message_start / message_delta usage extraction
# ---------------------------------------------------------------------------


async def test_stream_message_extracts_usage_from_message_start():
    """The first SSE event the SDK emits is `message_start` carrying
    initial input_tokens. Adapter must surface that as a `usage`
    StreamEvent before the message_stop sentinel."""
    p = _make_provider()

    async def fake_stream():
        # message_start carries initial usage (input + cache + output start)
        yield _FakeAttr(
            type="message_start",
            message=_FakeAttr(
                usage=_FakeAttr(input_tokens=100, output_tokens=0),
            ),
        )
        # text block
        yield _FakeAttr(type="content_block_start", index=0,
                        content_block=_FakeAttr(type="text"))
        yield _FakeAttr(type="content_block_delta", index=0,
                        delta=_FakeAttr(type="text_delta", text="hi"))
        yield _FakeAttr(type="content_block_stop", index=0)
        # message_delta carries final output_tokens
        yield _FakeAttr(
            type="message_delta",
            usage=_FakeAttr(output_tokens=25),
        )

    p.client.messages.create = AsyncMock(return_value=fake_stream())

    events = []
    async for ev in p.stream_message(
        model="sonnet", system=None, messages=[], tools=[],
    ):
        events.append(ev)

    usage_events = [e for e in events if e.type == "usage"]
    assert len(usage_events) == 2
    assert usage_events[0].usage == {"input_tokens": 100}
    assert usage_events[1].usage == {"output_tokens": 25}

    # Always closes with message_stop
    assert events[-1].type == "message_stop"


async def test_stream_message_skips_message_start_without_usage():
    """If `message_start.message.usage` is missing or zero, no `usage`
    event must fire (the source guards on truthy input/output tokens)."""
    p = _make_provider()

    async def fake_stream():
        yield _FakeAttr(
            type="message_start",
            message=_FakeAttr(usage=_FakeAttr(input_tokens=0, output_tokens=0)),
        )
        yield _FakeAttr(
            type="message_delta",
            usage=None,
        )

    p.client.messages.create = AsyncMock(return_value=fake_stream())

    events = []
    async for ev in p.stream_message(
        model="sonnet", system=None, messages=[], tools=[],
    ):
        events.append(ev)

    usage_events = [e for e in events if e.type == "usage"]
    assert usage_events == []


async def test_stream_message_input_json_delta_streamed():
    """The tool_use streaming path: input_json_delta chunks must be
    surfaced as content_block_delta with delta_type=input_json_delta."""
    p = _make_provider()

    async def fake_stream():
        yield _FakeAttr(
            type="content_block_start", index=0,
            content_block=_FakeAttr(type="tool_use", name="Read", id="toolu_1"),
        )
        yield _FakeAttr(
            type="content_block_delta", index=0,
            delta=_FakeAttr(type="input_json_delta", partial_json='{"pa'),
        )
        yield _FakeAttr(
            type="content_block_delta", index=0,
            delta=_FakeAttr(type="input_json_delta", partial_json='th": "/x"}'),
        )
        yield _FakeAttr(type="content_block_stop", index=0)

    p.client.messages.create = AsyncMock(return_value=fake_stream())

    events = []
    async for ev in p.stream_message(
        model="sonnet", system=None, messages=[], tools=[],
    ):
        events.append(ev)

    starts = [e for e in events if e.type == "content_block_start"]
    deltas = [e for e in events if e.type == "content_block_delta"
              and e.delta_type == "input_json_delta"]
    assert len(starts) == 1
    assert starts[0].block_type == "tool_use"
    assert starts[0].tool_name == "Read"
    assert starts[0].tool_id == "toolu_1"
    assert len(deltas) == 2
    assert "".join(d.text for d in deltas) == '{"path": "/x"}'


async def test_stream_message_passes_system_and_tools_to_sdk():
    """Smoke-test that system + tool schemas reach the SDK call."""
    p = _make_provider()

    async def empty_stream():
        if False:
            yield None  # never yields — empty generator
        return

    p.client.messages.create = AsyncMock(return_value=empty_stream())

    async for _ in p.stream_message(
        model="sonnet",
        system="be helpful",
        messages=[ProviderMessage(role="user", content="hi")],
        tools=[ToolSchema(name="Read", description="d", input_schema={"type": "object"})],
        max_tokens=2048,
    ):
        pass

    _, kwargs = p.client.messages.create.call_args
    assert kwargs["model"] == MODEL_MAP["sonnet"]
    assert kwargs["system"] == "be helpful"
    assert kwargs["max_tokens"] == 2048
    assert kwargs["stream"] is True
    assert kwargs["tools"] == [{"name": "Read", "description": "d", "input_schema": {"type": "object"}}]
    assert kwargs["messages"] == [{"role": "user", "content": "hi"}]


# ---------------------------------------------------------------------------
# stream_and_collect default raises
# ---------------------------------------------------------------------------


async def test_stream_and_collect_raises_not_implemented():
    """The helper isn't used directly by AgentLoop — provider hides it
    behind a NotImplementedError to prevent accidental adoption."""
    p = _make_provider()
    with pytest.raises(NotImplementedError):
        await p.stream_and_collect(
            model="sonnet", system=None, messages=[], tools=[],
        )


# ---------------------------------------------------------------------------
# Constructor kwarg handling
# ---------------------------------------------------------------------------


def test_constructor_prefers_auth_token_over_api_key():
    """When both are passed, auth_token wins (the elif branch in the
    constructor); api_key is silently dropped."""
    import anthropic

    captured: dict[str, Any] = {}

    class _Stub:
        def __init__(self, **kwargs):
            captured.update(kwargs)

    real = anthropic.AsyncAnthropic
    anthropic.AsyncAnthropic = _Stub
    try:
        AnthropicProvider(api_key="key", auth_token="tok", base_url="http://x")
    finally:
        anthropic.AsyncAnthropic = real

    assert captured.get("auth_token") == "tok"
    assert "api_key" not in captured
    assert captured.get("base_url") == "http://x"


def test_constructor_no_creds_passes_no_kwargs():
    import anthropic

    captured: dict[str, Any] = {}

    class _Stub:
        def __init__(self, **kwargs):
            captured.update(kwargs)

    real = anthropic.AsyncAnthropic
    anthropic.AsyncAnthropic = _Stub
    try:
        AnthropicProvider()
    finally:
        anthropic.AsyncAnthropic = real

    assert captured == {}
