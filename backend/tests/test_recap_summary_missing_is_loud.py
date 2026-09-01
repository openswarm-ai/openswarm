"""The agent's memory loss had no signal at all, which is why it kept being unexplainable.

A fresh-session rebuild sends the recap (the user's asks + the tool trail, never the model's own
replies, by design) plus a model-written distilled summary of the dropped span. That summary IS the
agent's memory of its own earlier conclusions. `distilled_history_summary` returns "" for FIVE
different reasons, and only one of them logged, at DEBUG:

    feature off | cutoff no longer on the branch | empty body | aux call raised | aux returned ""

The aux call is a real LLM call, so it fails whenever aux is unavailable (observed live:
"No AI provider connected for auxiliary LLM call"). When it does, the rebuilt turn knows what was
ASKED and which tools ran, but not what it CONCLUDED, which is exactly the field report: the agent
confidently described work that did not exist, then retracted it after re-reading the workspace.

Rule: a guard may never disable itself in silence.
"""
import inspect

from backend.apps.agents.manager.run import RunOptions as RO
from backend.apps.agents.manager.session import distill_history


def p_src():
    return inspect.getsource(RO)


def test_a_rebuild_with_no_summary_warns_and_reports():
    src = p_src()
    i = src.index('elif session.compacted_through_msg_id and p_mode != "none":')
    block = src[i:i + 1600]
    assert "logger.warning" in block, "silence is the bug; it must say so"
    assert '"kind": "recap_summary_missing"' in block, "and it must be queryable on the fleet"
    assert "session_id" in block, "ENG-397's lesson: an envelope with no session is untestable"


def test_it_only_fires_when_memory_was_actually_expected():
    """No cutoff means nothing was dropped, so nothing was lost; `none` means a policy block already
    stripped the recap deliberately. Neither is the memory-loss case."""
    src = p_src()
    i = src.index('elif session.compacted_through_msg_id and p_mode != "none":')
    cond = src[i:i + 90]
    assert "compacted_through_msg_id" in cond
    assert 'p_mode != "none"' in cond


def test_it_sits_on_the_else_of_the_summary_being_present():
    """It must be the ELSE of `if distilled:`, or it would fire on healthy rebuilds too."""
    src = p_src()
    assert src.index("if distilled:") < src.index('elif session.compacted_through_msg_id')


def test_the_distiller_really_has_five_silent_exits():
    """If this count ever changes, the comment above the warning is stale and should be re-read."""
    src = inspect.getsource(distill_history.distilled_history_summary)
    assert src.count('return ""') == 5, f"expected 5 silent-empty exits, found {src.count('return ')}"


def test_the_feature_is_on_by_default():
    """A default-off distiller would make every long chat forget, which is worth knowing loudly."""
    assert distill_history.DISTILL_ENABLED is True
