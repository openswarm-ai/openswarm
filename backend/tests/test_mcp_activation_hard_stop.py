"""Activating an MCP server must END the turn, not ask the model nicely to stop.

MCPActivate returns "its tools are NOT callable in this turn ... Do not attempt any other tool call
now" and queues a hidden continuation for afterwards. That was advisory, and models ignored it: the
observed behaviour was activate google-workspace, then immediately guess `send email`, send a
message with a wrong subject, then narrate "Wrong tool name guess. Let me find the actual Gmail tool
names." Every MCP task looked broken, on every install since 1.6.0.

The activated tools genuinely do not exist until the transport is rebuilt, so anything the model
does after activating is guesswork by construction. The loop now breaks on the flag.
"""
import inspect

from backend.apps.agents.manager.run import TurnRunner


def p_loop_source() -> str:
    src = inspect.getsource(TurnRunner)
    start = src.index("async def p_run_streaming_turn")
    return src[start:start + 3000]


def test_the_turn_loop_breaks_on_a_pending_continuation():
    body = p_loop_source()
    assert "pending_continuation" in body, "nothing ends the turn, so the model keeps guessing"
    assert "break" in body


def test_the_check_runs_BEFORE_the_message_is_handled():
    """A check after handling would still let the model's next tool call execute, which is the
    whole bug: the wrong-named call already went out."""
    body = p_loop_source()
    loop_at = body.index("async for message in")
    check_at = body.index("pending_continuation")
    handled_at = body.index("isinstance(message, ResultMessage)")
    assert loop_at < check_at < handled_at, (
        "the flag must be read at the top of the iteration, before any message handling"
    )


def test_the_reason_is_recorded_where_the_next_reader_will_look():
    body = p_loop_source()
    assert "guess" in body.lower(), "a bare break invites someone to delete it as dead code"


def test_the_continuation_hook_still_consumes_the_flag():
    """Breaking the loop is only half of it. If the end-of-loop hook stopped firing, activation
    would leave the user with a dead turn and no follow-up at all, which is worse than guessing."""
    from backend.apps.agents import agent_manager

    src = inspect.getsource(agent_manager)
    assert "pending_continuation" in src
    assert "hidden=True" in src, "the continuation must not add a visible user bubble"


def test_the_activation_response_still_tells_the_model_what_happened():
    """The hard stop is the enforcement; the words are still what the model reads on the next turn
    to understand why it was cut off."""
    from backend.apps.agents import mcp_meta_server

    src = inspect.getsource(mcp_meta_server)
    assert "NOT callable in this turn" in src
    assert "continuation turn will fire" in src
