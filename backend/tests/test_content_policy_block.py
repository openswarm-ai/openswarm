"""Pins the content-policy-block contract (Alex's bricked-chat class: 192 subscription-lane blocks
in 14 days, 0 on API keys): the recap never carries the model's own replies, a block on a
recap-bearing turn retries once with no history and the session stays that way, every block is
reported to telemetry with the shape it sent, and the assistant-text door routes it to the same
owner instead of carding a retry that never happens."""

import asyncio

from backend.apps.agents.core.error_classify import is_content_policy_block, is_transient_capacity_error
from backend.apps.agents.core.models import AgentSession, Message
from backend.apps.agents.manager.run import handle_run_error as hre
from backend.apps.agents.manager.run.handle_run_error import handle_run_error
from backend.apps.agents.session_credential import api_key_twin_model
from backend.apps.settings.models import AppSettings
from backend.apps.agents.manager.session.history_compaction import build_history_prefix
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


def p_settings(**kw) -> AppSettings:
    return AppSettings(**kw)


def p_block(s: AgentSession, captured: list, monkeypatch, text: str = TOS_TEXT, settings: AppSettings | None = None) -> None:
    monkeypatch.setattr(svc, "submit_diagnostic", lambda d: captured.append(d))
    # The real settings file on a dev box may hold an API key; the failover must be opted into per test.
    monkeypatch.setattr(hre, "load_settings", lambda: settings or p_settings())
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
    assert s.history_prefix_mode == "minimal"
    assert s.history_prefix_sent == "none"


def test_block_on_a_recap_bearing_turn_drops_to_none_and_retries_silently(monkeypatch):
    captured: list = []
    s = p_session_with_history()
    s.history_prefix_sent = "minimal"
    p_block(s, captured, monkeypatch)
    assert s.history_prefix_mode == "none"
    assert s.needs_fresh_session is True, "the retry must respawn so the empty prefix is what goes out"
    assert s.pending_continuation is True
    assert not any(m.role == "system" for m in s.messages), "retry turn must be silent, no card yet"
    assert [d["subkind"] for d in captured if d.get("kind") == "model_error"] == ["policy_block:minimal"]


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
    assert s.history_prefix_mode == "minimal"


def test_recap_carries_the_asks_and_the_tool_trail_but_never_the_models_replies():
    """Claude Code and hermes keep old answers only as model-written summaries; a verbatim replay of
    the model's own text, in text we author, is what the subscription-lane filter blocks."""
    s = AgentSession(name="t", model="sonnet")
    s.messages.append(Message(role="user", content="find candidates for the role"))
    s.messages.append(Message(role="assistant", content="I found three strong profiles, here they are in full."))
    s.messages.append(Message(role="tool_call", content={"tool": "Bash", "input": {"command": "ls"}}))
    s.messages.append(Message(role="tool_result", content={"text": "a.txt b.txt"}))
    recap = build_history_prefix(s.messages)
    assert "The user asked: find candidates for the role" in recap
    assert "three strong profiles" not in recap
    assert "You replied" not in recap
    assert "\nAssistant: " not in recap and "\nUser: " not in recap
    assert "Bash" in recap, "the tool trail stays: commands are re-runnable and are not model prose"
    assert "a.txt" in recap, "tool results are data the model read, not text it wrote"
    assert "YOUR OWN earlier turns" in recap


def test_api_key_twin_only_for_a_subscription_lane_with_the_users_own_key():
    """ENG-383: same Claude, same provider, the user's own key; never the pool, never another vendor."""
    assert api_key_twin_model("opus-5-cc", p_settings(anthropic_api_key="sk-ant-x")) == "opus-5-api"
    assert api_key_twin_model("opus-5-cc", p_settings()) is None, "no key, nothing to fail over to"
    assert api_key_twin_model("opus-5-api", p_settings(anthropic_api_key="sk-ant-x")) is None, "already on the key"
    assert api_key_twin_model("opus-5-cc", p_settings(anthropic_api_key="sk-ant-x", connection_mode="openswarm-pro")) is None, "the Pro pool never fails over silently"
    assert api_key_twin_model("gpt-5.5", p_settings(anthropic_api_key="sk-ant-x")) is None, "another provider's block is not Anthropic's key to spend"


def test_block_with_no_recap_fails_over_to_the_users_own_api_key(monkeypatch):
    captured: list = []
    s = p_session_with_history()
    s.model = "opus-5-cc"
    s.history_prefix_mode = "none"
    s.history_prefix_sent = "none"
    p_block(s, captured, monkeypatch, settings=p_settings(anthropic_api_key="sk-ant-x"))
    assert s.model == "opus-5-api"
    assert s.pending_continuation is True and s.needs_fresh_session is True
    cards = [m for m in s.messages if m.role == "system"]
    assert len(cards) == 1 and "API key" in str(cards[0].content) and "declined" not in str(cards[0].content).lower().replace("declined this request on your subscription", "")
    kinds = [(d.get("kind"), d.get("subkind")) for d in captured]
    assert ("model_error", "policy_block:none") in kinds, "the block itself is still reported"
    assert ("recovered", "lane_failover") in kinds, "the failover lands in the near-miss ledger"


def test_block_with_no_recap_and_no_key_still_ends_with_the_card(monkeypatch):
    captured: list = []
    s = p_session_with_history()
    s.model = "opus-5-cc"
    s.history_prefix_mode = "none"
    s.history_prefix_sent = "none"
    p_block(s, captured, monkeypatch, settings=p_settings())
    assert s.model == "opus-5-cc" and s.pending_continuation is False
    assert [m for m in s.messages if m.role == "system"][0].content.startswith("The model provider declined")
