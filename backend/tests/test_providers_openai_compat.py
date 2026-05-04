"""Tests for `backend.apps.agents.providers.openai_compat`.

The whole module currently sits at 0% coverage because no other test
exercises an OpenAI-compatible provider. We mock the `AsyncOpenAI`
client so all paths run with no network access:

  - `format_user_message`: string + multimodal (text + image) blocks
  - `format_assistant_message`: text-only, mixed text+tool_use,
    tool_use only (content=None branch)
  - `format_tool_result`: text + image + raw json fallback
  - `_build_messages`: system prefix, assistant in OpenAI format,
    assistant in Anthropic-block format, tool_result list / single
    dict, user passthrough
  - `create_message`: text completion + tool_calls, finish_reason
    handling, usage extraction
  - `stream_message`: text-delta chunks, tool-call streaming with
    json delta accumulation, usage-only final chunk, finish_reason
    closing all open blocks
  - `clean_tool_schema`: OpenAI function-calling shape
  - `get_model_id`: passthrough (no short-name mapping)
"""

from __future__ import annotations

import json
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from backend.apps.agents.providers.base import (
    ContentBlock,
    ModelResponse,
    ProviderMessage,
    ToolCall,
    ToolSchema,
)
from backend.apps.agents.providers.openai_compat import OpenAICompatProvider


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


class _FakeAttr:
    """Generic dot-attribute object for SDK-shaped responses."""

    def __init__(self, **kwargs: Any) -> None:
        for k, v in kwargs.items():
            setattr(self, k, v)


def _make_provider() -> OpenAICompatProvider:
    p = OpenAICompatProvider(api_key="test-key", base_url="http://example.invalid")
    p.client = MagicMock()
    p.client.chat = MagicMock()
    p.client.chat.completions = MagicMock()
    p.client.chat.completions.create = AsyncMock()
    return p


# ---------------------------------------------------------------------------
# Constructor + simple helpers
# ---------------------------------------------------------------------------


def test_get_model_id_is_passthrough():
    """OpenAI-compatible doesn't do short-name mapping; user supplies
    the exact API model id."""
    p = _make_provider()
    assert p.get_model_id("gpt-5.4") == "gpt-5.4"
    assert p.get_model_id("anything-else") == "anything-else"


def test_clean_tool_schema_returns_openai_function_format():
    p = _make_provider()
    schema = ToolSchema(
        name="Read",
        description="Read a file",
        input_schema={"type": "object", "properties": {"path": {"type": "string"}}},
    )
    out = p.clean_tool_schema(schema)
    assert out == {
        "type": "function",
        "function": {
            "name": "Read",
            "description": "Read a file",
            "parameters": {
                "type": "object",
                "properties": {"path": {"type": "string"}},
            },
        },
    }


def test_constructor_defaults_api_key_to_none_placeholder():
    """Some endpoints don't need real keys; the adapter sends "none"
    rather than failing. Capture the kwargs to verify."""
    from openai import AsyncOpenAI as _RealOpenAI
    captured: dict[str, Any] = {}

    class _Stub:
        def __init__(self, **kwargs):
            captured.update(kwargs)

    import backend.apps.agents.providers.openai_compat as oc_mod
    real = oc_mod.AsyncOpenAI
    oc_mod.AsyncOpenAI = _Stub
    try:
        OpenAICompatProvider(api_key="", base_url=None)
    finally:
        oc_mod.AsyncOpenAI = real
    assert captured.get("api_key") == "none"
    assert "base_url" not in captured


# ---------------------------------------------------------------------------
# format_user_message
# ---------------------------------------------------------------------------


def test_format_user_message_string():
    p = _make_provider()
    msg = p.format_user_message("hello")
    assert msg.role == "user"
    assert msg.content == "hello"


def test_format_user_message_multimodal_text_and_image():
    """Text + Anthropic-style image blocks → OpenAI image_url with
    base64 data URL."""
    p = _make_provider()
    blocks = [
        {"type": "text", "text": "look:"},
        {
            "type": "image",
            "source": {"type": "base64", "media_type": "image/png", "data": "AA=="},
        },
        "trailing string",  # str gets coerced to a text part
    ]
    msg = p.format_user_message(blocks)
    assert msg.role == "user"
    assert msg.content == [
        {"type": "text", "text": "look:"},
        {
            "type": "image_url",
            "image_url": {"url": "data:image/png;base64,AA=="},
        },
        {"type": "text", "text": "trailing string"},
    ]


def test_format_user_message_other_types_str_coerced():
    p = _make_provider()
    msg = p.format_user_message(42)
    assert msg.role == "user"
    assert msg.content == "42"


# ---------------------------------------------------------------------------
# format_assistant_message
# ---------------------------------------------------------------------------


def test_format_assistant_message_text_only():
    p = _make_provider()
    resp = ModelResponse(
        content=[
            ContentBlock(type="text", text="line one"),
            ContentBlock(type="text", text="line two"),
        ],
        stop_reason="end_turn",
    )
    msg = p.format_assistant_message(resp)
    # Stored under content -> dict (already in OpenAI shape) so _build_messages
    # can pass it through unchanged.
    assert msg.role == "assistant"
    assert msg.content == {"role": "assistant", "content": "line one\nline two"}


def test_format_assistant_message_tool_use_only_sets_content_to_none():
    p = _make_provider()
    resp = ModelResponse(
        content=[
            ContentBlock(
                type="tool_use",
                tool_call=ToolCall(id="t1", name="Read", input={"path": "/x"}),
            ),
        ],
        stop_reason="tool_use",
    )
    msg = p.format_assistant_message(resp)
    assert msg.content["content"] is None
    assert msg.content["tool_calls"] == [{
        "id": "t1",
        "type": "function",
        "function": {"name": "Read", "arguments": json.dumps({"path": "/x"})},
    }]


def test_format_assistant_message_mixed_text_and_tool_use():
    p = _make_provider()
    resp = ModelResponse(
        content=[
            ContentBlock(type="text", text="thinking"),
            ContentBlock(
                type="tool_use",
                tool_call=ToolCall(id="t1", name="Bash", input={"cmd": "ls"}),
            ),
        ],
        stop_reason="tool_use",
    )
    msg = p.format_assistant_message(resp)
    assert msg.content["content"] == "thinking"
    assert len(msg.content["tool_calls"]) == 1
    tc = msg.content["tool_calls"][0]
    assert tc["function"]["name"] == "Bash"
    assert json.loads(tc["function"]["arguments"]) == {"cmd": "ls"}


# ---------------------------------------------------------------------------
# format_tool_result
# ---------------------------------------------------------------------------


def test_format_tool_result_collapses_text_blocks_to_single_string():
    p = _make_provider()
    out = p.format_tool_result("call_1", [
        {"type": "text", "text": "line a"},
        {"type": "text", "text": "line b"},
    ])
    assert out == {
        "role": "tool",
        "tool_call_id": "call_1",
        "content": "line a\nline b",
    }


def test_format_tool_result_image_blocks_become_placeholder():
    p = _make_provider()
    out = p.format_tool_result("call_2", [
        {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "AA=="}},
    ])
    assert out["content"] == "[image]"


def test_format_tool_result_unknown_block_falls_back_to_json():
    p = _make_provider()
    block = {"type": "custom", "x": 1}
    out = p.format_tool_result("call_3", [block])
    assert out["content"] == json.dumps(block)


def test_format_tool_result_empty_returns_done_marker():
    """Empty content list → "Done." so OpenAI doesn't reject the
    message for empty content."""
    p = _make_provider()
    out = p.format_tool_result("call_4", [])
    assert out["content"] == "Done."


# ---------------------------------------------------------------------------
# _build_messages
# ---------------------------------------------------------------------------


def test_build_messages_includes_system_prefix():
    p = _make_provider()
    out = p._build_messages("you are helpful", [
        ProviderMessage(role="user", content="hi"),
    ])
    assert out[0] == {"role": "system", "content": "you are helpful"}
    assert out[1] == {"role": "user", "content": "hi"}


def test_build_messages_no_system_no_prefix():
    p = _make_provider()
    out = p._build_messages(None, [ProviderMessage(role="user", content="hi")])
    assert out == [{"role": "user", "content": "hi"}]


def test_build_messages_assistant_in_openai_shape_passes_through():
    """`format_assistant_message` already produces OpenAI-shape dicts;
    `_build_messages` must pass them through unchanged."""
    p = _make_provider()
    asst_dict = {"role": "assistant", "content": "hello"}
    out = p._build_messages(None, [ProviderMessage(role="assistant", content=asst_dict)])
    assert out == [asst_dict]


def test_build_messages_assistant_in_anthropic_block_format():
    """Coming from a cross-provider session, the assistant content
    might still be in Anthropic block format. _build_messages must
    translate it."""
    p = _make_provider()
    blocks = [
        {"type": "text", "text": "thinking"},
        {"type": "tool_use", "id": "t1", "name": "Read", "input": {"path": "/x"}},
    ]
    out = p._build_messages(None, [ProviderMessage(role="assistant", content=blocks)])
    assert out[0]["role"] == "assistant"
    assert out[0]["content"] == "thinking"
    assert out[0]["tool_calls"] == [{
        "id": "t1",
        "type": "function",
        "function": {"name": "Read", "arguments": json.dumps({"path": "/x"})},
    }]


def test_build_messages_tool_result_list_each_appended():
    p = _make_provider()
    tool_results = [
        {"role": "tool", "tool_call_id": "t1", "content": "ok"},
        {"role": "tool", "tool_call_id": "t2", "content": "ok2"},
    ]
    out = p._build_messages(None, [ProviderMessage(role="tool_result", content=tool_results)])
    assert out == tool_results


def test_build_messages_tool_result_single_dict_appended():
    p = _make_provider()
    tr = {"role": "tool", "tool_call_id": "t1", "content": "ok"}
    out = p._build_messages(None, [ProviderMessage(role="tool_result", content=tr)])
    assert out == [tr]


def test_build_messages_tool_result_without_tool_call_id_dropped():
    """Defensive: a malformed tool_result without `tool_call_id` is
    silently dropped to avoid crashing the API call."""
    p = _make_provider()
    out = p._build_messages(None, [
        ProviderMessage(role="tool_result", content={"role": "tool", "content": "x"}),
    ])
    assert out == []


def test_build_messages_user_string_passthrough():
    p = _make_provider()
    out = p._build_messages(None, [ProviderMessage(role="user", content="hi")])
    assert out == [{"role": "user", "content": "hi"}]


# ---------------------------------------------------------------------------
# create_message (non-streaming)
# ---------------------------------------------------------------------------


async def test_create_message_text_only_response():
    p = _make_provider()
    fake_resp = _FakeAttr(
        choices=[
            _FakeAttr(
                message=_FakeAttr(content="hello", tool_calls=None),
                finish_reason="stop",
            ),
        ],
        usage=_FakeAttr(prompt_tokens=12, completion_tokens=3),
    )
    p.client.chat.completions.create = AsyncMock(return_value=fake_resp)

    out = await p.create_message(
        model="gpt-5.4",
        system="be useful",
        messages=[ProviderMessage(role="user", content="hi")],
        tools=[],
    )

    _, kwargs = p.client.chat.completions.create.call_args
    assert kwargs["model"] == "gpt-5.4"  # passthrough
    assert kwargs["max_tokens"] == 8192
    assert kwargs["messages"][0] == {"role": "system", "content": "be useful"}
    assert kwargs["messages"][1] == {"role": "user", "content": "hi"}
    assert "tools" not in kwargs

    assert out.stop_reason == "end_turn"
    assert len(out.content) == 1
    assert out.content[0].type == "text"
    assert out.content[0].text == "hello"
    assert out.usage == {"input_tokens": 12, "output_tokens": 3}


async def test_create_message_tool_calls_translation():
    p = _make_provider()
    fake_resp = _FakeAttr(
        choices=[
            _FakeAttr(
                message=_FakeAttr(
                    content=None,
                    tool_calls=[
                        _FakeAttr(
                            id="call_1",
                            function=_FakeAttr(
                                name="Read",
                                arguments=json.dumps({"path": "/tmp/a"}),
                            ),
                        ),
                    ],
                ),
                finish_reason="tool_calls",
            ),
        ],
        usage=_FakeAttr(prompt_tokens=5, completion_tokens=2),
    )
    p.client.chat.completions.create = AsyncMock(return_value=fake_resp)

    out = await p.create_message(
        model="gpt-5.4",
        system=None,
        messages=[ProviderMessage(role="user", content="x")],
        tools=[ToolSchema(name="Read", description="d", input_schema={"type": "object"})],
    )

    _, kwargs = p.client.chat.completions.create.call_args
    assert kwargs["tools"] == [{
        "type": "function",
        "function": {"name": "Read", "description": "d", "parameters": {"type": "object"}},
    }]

    assert out.stop_reason == "tool_use"
    assert len(out.content) == 1
    assert out.content[0].type == "tool_use"
    assert out.content[0].tool_call.id == "call_1"
    assert out.content[0].tool_call.name == "Read"
    assert out.content[0].tool_call.input == {"path": "/tmp/a"}


async def test_create_message_invalid_tool_args_json_falls_back_to_empty():
    """Malformed JSON in `function.arguments` must NOT crash; the adapter
    swallows the JSONDecodeError and leaves input={}."""
    p = _make_provider()
    fake_resp = _FakeAttr(
        choices=[
            _FakeAttr(
                message=_FakeAttr(
                    content=None,
                    tool_calls=[
                        _FakeAttr(
                            id="call_1",
                            function=_FakeAttr(name="Read", arguments="{not valid json"),
                        ),
                    ],
                ),
                finish_reason="tool_calls",
            ),
        ],
        usage=None,
    )
    p.client.chat.completions.create = AsyncMock(return_value=fake_resp)

    out = await p.create_message(
        model="gpt-5.4", system=None,
        messages=[ProviderMessage(role="user", content="x")], tools=[],
    )
    assert out.content[0].tool_call.input == {}
    assert out.usage == {}


async def test_create_message_text_plus_tool_use_yields_tool_use_stop():
    """Mixed content with tool_calls → stop_reason becomes tool_use even
    if finish_reason was 'stop' (defensive against models that report
    'stop' alongside tool_calls)."""
    p = _make_provider()
    fake_resp = _FakeAttr(
        choices=[
            _FakeAttr(
                message=_FakeAttr(
                    content="thinking",
                    tool_calls=[
                        _FakeAttr(
                            id="c1",
                            function=_FakeAttr(name="Read", arguments="{}"),
                        ),
                    ],
                ),
                finish_reason="stop",  # not "tool_calls"
            ),
        ],
        usage=_FakeAttr(prompt_tokens=1, completion_tokens=1),
    )
    p.client.chat.completions.create = AsyncMock(return_value=fake_resp)

    out = await p.create_message(
        model="gpt-5.4", system=None,
        messages=[ProviderMessage(role="user", content="x")], tools=[],
    )
    assert out.stop_reason == "tool_use"


# ---------------------------------------------------------------------------
# stream_message
# ---------------------------------------------------------------------------


async def test_stream_message_text_only_chunks():
    p = _make_provider()

    async def fake_stream():
        yield _FakeAttr(
            choices=[_FakeAttr(
                delta=_FakeAttr(content="hel", tool_calls=None),
                finish_reason=None,
            )],
            usage=None,
        )
        yield _FakeAttr(
            choices=[_FakeAttr(
                delta=_FakeAttr(content="lo", tool_calls=None),
                finish_reason=None,
            )],
            usage=None,
        )
        yield _FakeAttr(
            choices=[_FakeAttr(
                delta=_FakeAttr(content=None, tool_calls=None),
                finish_reason="stop",
            )],
            usage=None,
        )
        # Final usage-only chunk
        yield _FakeAttr(
            choices=[],
            usage=_FakeAttr(prompt_tokens=10, completion_tokens=2),
        )

    p.client.chat.completions.create = AsyncMock(return_value=fake_stream())

    events = []
    async for ev in p.stream_message(model="gpt-5.4", system=None, messages=[], tools=[]):
        events.append(ev)

    starts = [e for e in events if e.type == "content_block_start"]
    deltas = [e for e in events if e.type == "content_block_delta"]
    stops = [e for e in events if e.type == "content_block_stop"]

    assert len(starts) == 1
    assert starts[0].block_type == "text"
    assert "".join(d.text for d in deltas) == "hello"
    assert len(stops) == 1
    assert any(e.type == "message_stop" for e in events)
    usage = [e for e in events if e.type == "usage"]
    assert usage and usage[0].usage == {"input_tokens": 10, "output_tokens": 2}


async def test_stream_message_tool_call_streamed():
    """Tool-call streaming: name comes in chunk 1, arguments stream in
    multiple JSON deltas. Adapter accumulates and emits normalized
    StreamEvents."""
    p = _make_provider()

    async def fake_stream():
        # chunk 1: tool_call begin (id + name)
        yield _FakeAttr(
            choices=[_FakeAttr(
                delta=_FakeAttr(
                    content=None,
                    tool_calls=[_FakeAttr(
                        index=0,
                        id="call_1",
                        function=_FakeAttr(name="Read", arguments=""),
                    )],
                ),
                finish_reason=None,
            )],
            usage=None,
        )
        # chunk 2: arguments part 1
        yield _FakeAttr(
            choices=[_FakeAttr(
                delta=_FakeAttr(
                    content=None,
                    tool_calls=[_FakeAttr(
                        index=0,
                        id=None,
                        function=_FakeAttr(name=None, arguments='{"pa'),
                    )],
                ),
                finish_reason=None,
            )],
            usage=None,
        )
        # chunk 3: arguments part 2 + finish
        yield _FakeAttr(
            choices=[_FakeAttr(
                delta=_FakeAttr(
                    content=None,
                    tool_calls=[_FakeAttr(
                        index=0,
                        id=None,
                        function=_FakeAttr(name=None, arguments='th": "/x"}'),
                    )],
                ),
                finish_reason="tool_calls",
            )],
            usage=None,
        )

    p.client.chat.completions.create = AsyncMock(return_value=fake_stream())

    events = []
    async for ev in p.stream_message(model="gpt-5.4", system=None, messages=[], tools=[]):
        events.append(ev)

    starts = [e for e in events if e.type == "content_block_start"]
    deltas = [e for e in events if e.type == "content_block_delta"]
    stops = [e for e in events if e.type == "content_block_stop"]

    assert len(starts) == 1
    assert starts[0].block_type == "tool_use"
    assert starts[0].tool_id == "call_1"
    assert starts[0].tool_name == "Read"
    json_deltas = [d for d in deltas if d.delta_type == "input_json_delta"]
    assert "".join(d.text for d in json_deltas) == '{"path": "/x"}'
    assert len(stops) == 1
    assert any(e.type == "message_stop" for e in events)


async def test_stream_message_text_then_tool_use_closes_text_block():
    """When text was already streaming and a tool_call begins, the
    text block must be closed first so the frontend's UI logic sees a
    clean handoff."""
    p = _make_provider()

    async def fake_stream():
        yield _FakeAttr(
            choices=[_FakeAttr(
                delta=_FakeAttr(content="thinking ", tool_calls=None),
                finish_reason=None,
            )],
            usage=None,
        )
        yield _FakeAttr(
            choices=[_FakeAttr(
                delta=_FakeAttr(
                    content=None,
                    tool_calls=[_FakeAttr(
                        index=0, id="call_1",
                        function=_FakeAttr(name="Read", arguments="{}"),
                    )],
                ),
                finish_reason="tool_calls",
            )],
            usage=None,
        )

    p.client.chat.completions.create = AsyncMock(return_value=fake_stream())

    events = []
    async for ev in p.stream_message(model="gpt-5.4", system=None, messages=[], tools=[]):
        events.append(ev)

    block_types = [e.block_type for e in events if e.type == "content_block_start"]
    stops = [e for e in events if e.type == "content_block_stop"]
    assert block_types == ["text", "tool_use"]
    # Text close fires when tool_call starts; tool_use close fires at finish.
    assert len(stops) == 2


async def test_stream_message_includes_usage_options_kwargs():
    """`stream_options.include_usage` MUST be passed so the final
    chunk carries token counts."""
    p = _make_provider()

    async def empty_stream():
        if False:
            yield None
        return

    p.client.chat.completions.create = AsyncMock(return_value=empty_stream())

    async for _ in p.stream_message(model="gpt-5.4", system=None, messages=[], tools=[]):
        pass

    _, kwargs = p.client.chat.completions.create.call_args
    assert kwargs["stream"] is True
    assert kwargs["stream_options"] == {"include_usage": True}
