"""Pins the content-policy-block contract (Alex's bricked-chat class, 57 blocks in 4 days on one
install): the provider's ToS/AUP refusal is terminal for the bytes that earned it, so the only
retry is one that carries LESS of the model's own text (full -> minimal -> none, a ratchet for the
session's life), the block is reported to telemetry at every step, the assistant-text door routes
it to the same owner instead of carding a retry that never happens, and the recap never replays a
long reply verbatim."""

import asyncio

from backend.apps.agents.core.error_classify import is_content_policy_block, is_transient_capacity_error
from backend.apps.agents.core.models import AgentSession, Message
from backend.apps.agents.manager.run.handle_run_error import handle_run_error
from backend.apps.agents.manager.session.history_compaction import RECAP_REPLY_GIST_CHARS, build_history_prefix
from backend.apps.agents.manager.streaming.state import TurnState
from backend.apps.service import client as svc

TOS_TEXT = (
    "API Error: 400 (request id: req_x) https://www.anthropic.com/legal/aup). This request was "
    "blocked as it seems to violate Anthropic's Terms of Service restrictions on reverse "
    "engineering or duplicating model outputs."
)
# Byte-exact tail of Alex's envelopes (install 517559f0, 2026-08-21).
FIELD_TAIL = (
    "ic.com/legal/aup). This request was blocked as it seems to violate Anthropic's Terms of Service "
    "restrictions on reverse engineering or duplicating model outputs. To learn more, visit "
    "https://www.anthropic.com/legal/commercial-terms. Try rephrasing the request or attempting a "
    "different approach. If you are seeing this refusal repeatedly, try running /model "
    "claude-sonnet-4-20250514 to switch models."
)


def p_session_with_history() -> AgentSession:
    s = AgentSession(name="t", model="opus-5")
    s.messages.append(Message(role="user", content="send the follow-up emails"))
    s.messages.append(Message(role="tool_call", content={"tool": "Read", "input": {}}))
    s.messages.append(Message(role="tool_result", content={"text": "x" * 300}))
    return s


def p_block(s: AgentSession, captured: list, monkeypatch, text: str = TOS_TEXT) -> None:
    monkeypatch.setattr(svc, "submit_diagnostic", lambda d: captured.append(d))
    asyncio.run(handle_run_error(Exception(text), s, "sid-pol", TurnState(), []))


def test_tos_block_detected():
    assert is_content_policy_block(TOS_TEXT) is True
    assert is_content_policy_block("The agent runtime reported this turn failed (error_during_execution). API Error: 400 https://www.anthrop" + FIELD_TAIL) is True
    assert is_content_policy_block("ordinary overloaded_error 529") is False


def test_tos_block_never_transient():
    """The retry ladder hammering this deterministic 400 was the snag-chip flicker."""
    assert is_transient_capacity_error(Exception(TOS_TEXT)) is False


def test_prefix_mode_defaults():
    s = AgentSession(name="t", model="sonnet")
    assert s.history_prefix_mode == "full"
    assert s.history_prefix_sent == "none"


def test_block_on_a_full_recap_ratchets_to_minimal_and_retries_silently(monkeypatch):
    captured: list = []
    s = p_session_with_history()
    s.history_prefix_sent = "full"
    p_block(s, captured, monkeypatch)
    assert s.history_prefix_mode == "minimal"
    assert s.needs_fresh_session is True, "the retry must respawn so the reduced prefix is what goes out"
    assert s.pending_continuation is True
    assert not any(m.role == "system" for m in s.messages), "retry turn must be silent, no card yet"
    assert [d["subkind"] for d in captured if d.get("kind") == "model_error"] == ["policy_block:full"]


def test_block_on_a_minimal_recap_ratchets_to_none(monkeypatch):
    captured: list = []
    s = p_session_with_history()
    s.history_prefix_mode = "minimal"
    s.history_prefix_sent = "minimal"
    p_block(s, captured, monkeypatch)
    assert s.history_prefix_mode == "none"
    assert s.pending_continuation is True
    assert [d["subkind"] for d in captured] == ["policy_block:minimal"]


def test_block_with_no_recap_renders_the_honest_terminal_card(monkeypatch):
    captured: list = []
    s = p_session_with_history()
    s.history_prefix_mode = "none"
    s.history_prefix_sent = "none"
    p_block(s, captured, monkeypatch, text="The agent runtime reported this turn failed (error_during_execution). API Error: 400 https://www.anthrop" + FIELD_TAIL)
    cards = [m for m in s.messages if m.role == "system"]
    assert len(cards) == 1 and "declined this request" in str(cards[0].content)
    assert "retried without the session summary" in str(cards[0].content)
    assert s.pending_continuation is False
    assert s.history_prefix_mode == "none", "the ratchet never goes back up"
    assert [d["subkind"] for d in captured] == ["policy_block:none"]


def test_a_block_on_a_brand_new_chat_cards_without_blaming_a_recap(monkeypatch):
    captured: list = []
    s = AgentSession(name="t", model="opus-5")
    s.messages.append(Message(role="user", content="hi"))
    p_block(s, captured, monkeypatch)
    cards = [m for m in s.messages if m.role == "system"]
    assert len(cards) == 1
    assert "retried without" not in str(cards[0].content)
    assert s.history_prefix_mode == "full"


def test_recap_is_first_person_not_transcript():
    s = AgentSession(name="t", model="sonnet")
    s.messages.append(Message(role="user", content="find candidates for the role"))
    s.messages.append(Message(role="assistant", content="I found three strong profiles."))
    recap = build_history_prefix(s.messages)
    assert "You replied:" in recap
    assert "The user asked:" in recap
    assert "\nAssistant: " not in recap, "bare transcript labels pattern-match distillation filters"
    assert "\nUser: " not in recap
    assert "YOUR OWN earlier turns" in recap


def test_full_recap_gists_a_long_reply_instead_of_replaying_it():
    s = AgentSession(name="t", model="sonnet")
    s.messages.append(Message(role="user", content="draft the email"))
    reply = "Dear team, " + ("this is the body of a long email. " * 200)
    s.messages.append(Message(role="assistant", content=reply))
    recap = build_history_prefix(s.messages)
    assert reply not in recap
    assert reply[:RECAP_REPLY_GIST_CHARS] in recap
    assert "omitted from recap" in recap


def test_minimal_recap_carries_zero_model_text():
    s = AgentSession(name="t", model="sonnet")
    s.messages.append(Message(role="user", content="send the follow-ups"))
    s.messages.append(Message(role="assistant", content="Drafting the first one now."))
    s.messages.append(Message(role="tool_call", content={"tool": "Bash", "input": {"command": "ls"}}))
    s.messages.append(Message(role="tool_result", content={"text": "a.txt b.txt"}))
    recap = build_history_prefix(s.messages, mode="minimal")
    assert "The user asked: send the follow-ups" in recap
    assert "You replied" not in recap
    assert "Drafting the first one" not in recap
    assert "a.txt" not in recap
    assert "Bash" in recap, "the tool trail stays: commands are re-runnable and are not model prose"
