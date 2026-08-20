"""The trigger that fires on cost instead of on a percentage of the window.

Measured bug this closes: our shaping cut 0.0% at every session size because the compaction
threshold is a fraction of the context window, and on a 1M lane that fraction is never reached, so
a 218K history shipped verbatim to a cliff the model chokes at first. Hermes hit the same wall and
solved it with a second, independent trigger (MIT, NousResearch/hermes-agent).
"""

from backend.apps.agents.core.models import AgentSession, Message
from backend.apps.agents.manager.session.proactive_prune import (
    PROACTIVE_PRUNE_TOKENS,
    arm_proactive_prune,
    should_proactively_prune,
)


def p_session(input_tokens: int, bulky_msgs: int = 40, window: int = 1_000_000) -> AgentSession:
    s = AgentSession(name="t", model="sonnet-5", dashboard_id="d")
    s.context_window = window
    s.tokens["input"] = input_tokens
    s.messages.append(Message(role="user", content="go", branch_id=s.active_branch_id))
    for i in range(bulky_msgs):
        s.messages.append(Message(role="tool_call", content={"tool": "Read", "input": {"n": i}},
                                  branch_id=s.active_branch_id))
        s.messages.append(Message(role="tool_result", content={"text": "x" * 20_000},
                                  branch_id=s.active_branch_id))
    return s


def test_a_big_history_on_a_1m_window_is_finally_pruned():
    """The exact case that shipped 0.0%: far past any sane cost, nowhere near 50% of 1M."""
    s = p_session(120_000)
    assert should_proactively_prune(s) is True


def test_a_small_session_is_left_alone():
    """Negative control: pruning a cheap session spends a prompt cache for nothing."""
    assert should_proactively_prune(p_session(5_000, bulky_msgs=2)) is False


def test_it_never_duplicates_the_work_the_real_threshold_is_about_to_do():
    """Above the compaction trigger the existing path owns it; two rebuilds would be one wasted."""
    s = p_session(700_000)
    assert should_proactively_prune(s) is False


def test_a_prune_that_reclaims_little_is_refused():
    """The prompt-cache contract: a rebuild rewrites bytes the provider cached, so it must earn it.
    A long conversation of SHORT messages has nothing worth reclaiming."""
    s = AgentSession(name="t", model="sonnet-5", dashboard_id="d")
    s.context_window = 1_000_000
    s.tokens["input"] = PROACTIVE_PRUNE_TOKENS + 10_000
    for i in range(60):
        s.messages.append(Message(role="user", content=f"q{i}", branch_id=s.active_branch_id))
        s.messages.append(Message(role="assistant", content=f"a{i}", branch_id=s.active_branch_id))
    assert should_proactively_prune(s) is False


def test_committing_disarms_until_history_regrows():
    """A session hovering at the line must not rebuild every single turn."""
    s = p_session(120_000)
    assert should_proactively_prune(s) is True
    arm_proactive_prune(s)
    assert s.needs_fresh_session is True, "the rebuild is what actually applies the aging"
    assert s.proactive_prune_rearm_tokens > 0

    # Same history again right after: disarmed.
    assert should_proactively_prune(s) is False

    # History genuinely regrown past the runway: armed again.
    for i in range(40):
        s.messages.append(Message(role="tool_call", content={"tool": "Read", "input": {"n": 900 + i}},
                                  branch_id=s.active_branch_id))
        s.messages.append(Message(role="tool_result", content={"text": "y" * 20_000},
                                  branch_id=s.active_branch_id))
    s.compacted_through_msg_id = None
    assert should_proactively_prune(s) is True


def test_the_trigger_is_not_a_fraction_of_the_window():
    """The whole correction: identical history fires on a 200K lane and a 1M lane alike, because
    the tokens cost the same money either way. Tying this to a percentage of the window is what
    let a 218K history sail through untouched on the big lane."""
    small = p_session(50_000, window=200_000)
    big = p_session(50_000, window=1_000_000)
    assert should_proactively_prune(small) is True
    assert should_proactively_prune(big) is True
