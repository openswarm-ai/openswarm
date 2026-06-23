"""Streaming harness: drive the real p_run_agent_loop with a MOCKED claude_agent_sdk.query
that yields a controlled SDK message sequence, and assert the session state + emitted WS
events. This is the safety net for restructuring the streaming loop (it had no isolated
coverage), so it pins the observable contract: streamed text lands as an assistant message,
tool calls are recorded, and the turn completes."""

import asyncio

import claude_agent_sdk
from claude_agent_sdk import AssistantMessage, ResultMessage
from claude_agent_sdk.types import TextBlock, ToolUseBlock, ThinkingBlock, StreamEvent

from backend.apps.agents.agent_manager import AgentManager
import backend.apps.agents.core.ws_manager as ws_mod


def _stream(event):
    return StreamEvent(uuid="u", session_id="sdk-1", event=event)


def _mock_query_yielding(*messages):
    async def _q(*args, **kwargs):
        for m in messages:
            yield m
    return _q


def _drive(monkeypatch, messages, prompt="hi"):
    """Run one p_run_agent_loop turn against a mocked SDK message stream; return (session, ws_events)."""
    events = []

    async def fake_send(session_id, event, data):
        events.append((event, data))

    monkeypatch.setattr(ws_mod.ws_manager, "send_to_session", fake_send, raising=True)
    monkeypatch.setattr(claude_agent_sdk, "query", _mock_query_yielding(*messages), raising=True)

    mgr = AgentManager()
    from backend.apps.agents.core.models import AgentSession
    session = AgentSession(name="t", model="sonnet", dashboard_id="d")
    mgr.sessions[session.id] = session
    asyncio.run(mgr.p_run_agent_loop(session.id, prompt))
    return session, events


def _result(**kw):
    base = dict(subtype="success", duration_ms=100, duration_api_ms=80, is_error=False,
                num_turns=1, session_id="sdk-1", usage={"input_tokens": 10, "output_tokens": 5})
    base.update(kw)
    return ResultMessage(**base)


def _assistant(blocks, **kw):
    base = dict(content=blocks, model="sonnet", message_id="m1", stop_reason="end_turn",
                session_id="sdk-1", usage={"input_tokens": 10, "output_tokens": 5})
    base.update(kw)
    return AssistantMessage(**base)


def test_loop_builds_direct_anthropic_key_env(monkeypatch):
    # Pin the provider env/route config the loop builds, the part the hook flagged as untested.
    # Drive the REAL loop with a direct-Anthropic-key config (own_key, a non-9router model, no
    # pinned api-route) and capture the ClaudeAgentOptions; the env must carry exactly the user's
    # Anthropic key so the SDK authenticates against api.anthropic.com directly.
    from backend.apps.settings.models import AppSettings
    import backend.apps.agents.providers.registry as reg
    import backend.apps.agents.agent_manager as am

    settings = AppSettings(anthropic_api_key="sk-ant-test123", connection_mode="own_key")
    monkeypatch.setattr(am, "load_settings", lambda: settings, raising=True)
    monkeypatch.setattr(reg, "get_api_type", lambda model: "anthropic", raising=True)
    monkeypatch.setattr(reg, "resolve_model_id_for_sdk", lambda model, s: "claude-sonnet-4-6", raising=True)
    monkeypatch.setattr(reg, "_find_builtin_model", lambda model: None, raising=True)

    captured = {}

    async def capturing_query(*args, **kwargs):
        captured["options"] = kwargs.get("options")
        yield _assistant([TextBlock(text="ok")])
        yield _result()

    async def fake_send(session_id, event, data):
        pass

    monkeypatch.setattr(ws_mod.ws_manager, "send_to_session", fake_send, raising=True)
    monkeypatch.setattr(claude_agent_sdk, "query", capturing_query, raising=True)

    mgr = AgentManager()
    from backend.apps.agents.core.models import AgentSession
    session = AgentSession(name="t", model="sonnet", dashboard_id="d")
    mgr.sessions[session.id] = session
    asyncio.run(mgr.p_run_agent_loop(session.id, "hi"))

    env = captured["options"].env
    assert env == {"ANTHROPIC_API_KEY": "sk-ant-test123"}  # direct key, no 9router proxy


def test_full_streaming_turn_drives_the_complete_ws_contract(monkeypatch):
    # The closest in-repo proxy for a live streaming run: drive the REAL loop with the exact
    # SDK sequence the live provider emits, partial StreamEvents (block start -> text deltas ->
    # stop -> message_stop), THEN the AssistantMessage envelope, THEN the ResultMessage. Asserts
    # the FULL observable contract the live UI consumes end to end (stream_start, the streamed
    # deltas, the committed assistant message, the token/context meter, the per-turn token math).
    # This exercises stream_event + assistant_message + result_message together, through the loop.
    msgs = [
        _stream({"type": "content_block_start", "index": 0, "content_block": {"type": "text"}}),
        _stream({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Hel"}}),
        _stream({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "lo!"}}),
        _stream({"type": "content_block_stop", "index": 0}),
        _stream({"type": "message_stop"}),
        _assistant([TextBlock(text="Hello!")], usage={"input_tokens": 100, "output_tokens": 50}),
        _result(usage={"input_tokens": 1100, "output_tokens": 550}),
    ]
    session, events = _drive(monkeypatch, msgs)
    types = [e for e, _ in events]
    # the live streaming sequence the UI renders token-by-token
    assert "agent:stream_start" in types
    assert types.count("agent:stream_delta") >= 2          # both text deltas streamed live
    # the turn's durable outputs
    assert "agent:message" in types                         # final assistant message committed
    assert "agent:context_update" in types                  # the token/context meter
    assert any(m.role == "assistant" and "Hello!" in str(m.content) for m in session.messages)
    assert session.status == "completed"
    assert session.tokens.get("output") == 550              # ResultMessage's authoritative token count landed
    assert session.tokens.get("input") == 1100


def test_loop_wires_all_four_hooks_to_a_live_hook_context(monkeypatch):
    # Integration coverage the unit tests can't give: capture the ClaudeAgentOptions the real
    # loop hands to query(), then invoke the WIRED hooks. This proves p_run_agent_loop builds a
    # HookContext (all required fields, incl. the live `sessions` registry) and the four thin
    # wrappers delegate to the extracted hook modules. The SDK never fires these under a mocked
    # query, so without this the wiring (not just the functions) would be untested.
    captured = {}

    async def capturing_query(*args, **kwargs):
        captured["options"] = kwargs.get("options")
        yield _assistant([TextBlock(text="ok")])
        yield _result()

    async def fake_send(session_id, event, data):
        pass

    monkeypatch.setattr(ws_mod.ws_manager, "send_to_session", fake_send, raising=True)
    monkeypatch.setattr(claude_agent_sdk, "query", capturing_query, raising=True)

    mgr = AgentManager()
    from backend.apps.agents.core.models import AgentSession
    session = AgentSession(name="t", model="sonnet", dashboard_id="d")
    mgr.sessions[session.id] = session
    asyncio.run(mgr.p_run_agent_loop(session.id, "hi"))

    options = captured["options"]
    assert options is not None
    assert callable(options.can_use_tool)
    pre = options.hooks["PreToolUse"][0].hooks
    post = options.hooks["PostToolUse"][0].hooks
    stop = options.hooks["Stop"][0].hooks
    assert pre and post and stop

    # Invoke the wired Stop hook: a non-view-builder session short-circuits to {} by reading
    # ctx.session.mode, so this drives the full wrapper -> hook_ctx -> stop_hook module path.
    assert asyncio.run(stop[0]({}, None, None)) == {}


def test_streamed_text_lands_as_assistant_message(monkeypatch):
    session, events = _drive(monkeypatch, [
        _assistant([TextBlock(text="Hello there")]),
        _result(),
    ])
    assert any(m.role == "assistant" and "Hello there" in str(m.content) for m in session.messages)
    assert session.status == "completed"
    # the assistant reply + the token meter are broadcast to the UI
    assert any(e == "agent:message" for e, _ in events)
    assert any(e == "agent:context_update" for e, _ in events)


def test_tool_use_is_recorded(monkeypatch):
    session, events = _drive(monkeypatch, [
        _assistant([ToolUseBlock(id="tu1", name="Read", input={"file_path": "/x.py"})]),
        _result(),
    ])
    assert any(m.role == "tool_call" for m in session.messages)
    # the tool name survives onto the recorded call
    assert any("Read" in str(m.content) for m in session.messages if m.role == "tool_call")
    assert session.status == "completed"


def test_text_then_tool_in_one_turn(monkeypatch):
    session, events = _drive(monkeypatch, [
        _assistant([TextBlock(text="Let me read it."), ToolUseBlock(id="tu1", name="Read", input={"file_path": "/x.py"})]),
        _result(),
    ])
    roles = [m.role for m in session.messages]
    assert "assistant" in roles and "tool_call" in roles
    assert session.status == "completed"


def test_completes_even_with_no_content(monkeypatch):
    # an empty assistant turn (e.g. a pure stop) must still finish cleanly, not hang
    session, events = _drive(monkeypatch, [_assistant([]), _result()])
    assert session.status == "completed"


def test_thinking_block_before_text_is_handled(monkeypatch):
    # a ThinkingBlock mutates the separate thinking-state cluster; the turn must still
    # surface the final answer and complete (pins the thinking path for the restructuring)
    session, events = _drive(monkeypatch, [
        _assistant([ThinkingBlock(thinking="let me reason about this", signature="sig-1"),
                    TextBlock(text="the answer is 42")]),
        _result(),
    ])
    assert any(m.role == "assistant" and "the answer is 42" in str(m.content) for m in session.messages)
    assert session.status == "completed"


def test_transient_capacity_error_is_retried_then_succeeds(monkeypatch):
    # the capacity-retry while-loop: first query() raises a transient error, the loop
    # backs off (sleep mocked to no-op) and re-queries, which succeeds. This is the exact
    # behavior the streaming restructuring must preserve.
    real_sleep = asyncio.sleep  # capture before patching to avoid self-recursion

    async def _fast_sleep(*a, **k):
        await real_sleep(0)  # still yields to the loop, but no real backoff delay

    monkeypatch.setattr(asyncio, "sleep", _fast_sleep)

    state = {"n": 0}

    async def flaky_query(*args, **kwargs):
        state["n"] += 1
        if state["n"] == 1:
            raise Exception("No pool capacity available. Try again shortly.")
        yield _assistant([TextBlock(text="Recovered after backoff")])
        yield _result()

    events = []

    async def fake_send(session_id, event, data):
        events.append((event, data))

    monkeypatch.setattr(ws_mod.ws_manager, "send_to_session", fake_send, raising=True)
    monkeypatch.setattr(claude_agent_sdk, "query", flaky_query, raising=True)

    mgr = AgentManager()
    from backend.apps.agents.core.models import AgentSession
    session = AgentSession(name="t", model="sonnet", dashboard_id="d")
    mgr.sessions[session.id] = session
    asyncio.run(mgr.p_run_agent_loop(session.id, "hi"))

    assert state["n"] == 2  # retried exactly once
    assert any(m.role == "assistant" and "Recovered" in str(m.content) for m in session.messages)
    assert session.status == "completed"


def test_thinking_pill_shows_per_turn_delta_not_cumulative(monkeypatch):
    # The pill's token total must reflect THIS turn's new tokens, not the whole session's
    # running cumulative (the baseline-delta fix: capture-at-turn-start, subtract-at-emit,
    # unified through TurnState). Prior turns left 1500 tokens on the session; this turn adds
    # 100 in + 50 out = 150. Before the fix the baseline writes leaked into a closure-local
    # and the pill showed the cumulative 1650; now it shows 150.
    pills = []

    async def fake_send(sid, event, data):
        msg = data.get("message") if isinstance(data, dict) else None
        if isinstance(msg, dict) and msg.get("role") == "thinking":
            pills.append(msg)

    async def q(*a, **k):
        yield _assistant([ThinkingBlock(thinking="reasoning", signature="s"), TextBlock(text="answer")],
                         usage={"input_tokens": 100, "output_tokens": 50})
        yield _result(usage={"input_tokens": 1100, "output_tokens": 550})

    monkeypatch.setattr(ws_mod.ws_manager, "send_to_session", fake_send, raising=True)
    monkeypatch.setattr(claude_agent_sdk, "query", q, raising=True)

    mgr = AgentManager()
    from backend.apps.agents.core.models import AgentSession
    session = AgentSession(name="t", model="sonnet", dashboard_id="d")
    session.tokens = {"input_fresh": 1000, "output": 500}  # prior-turn accumulation
    mgr.sessions[session.id] = session
    asyncio.run(mgr.p_run_agent_loop(session.id, "hi"))

    assert pills, "expected a consolidated thinking pill"
    assert pills[-1]["input_tokens"] == 150  # (1100-1000)+(550-500), not the cumulative 1650
