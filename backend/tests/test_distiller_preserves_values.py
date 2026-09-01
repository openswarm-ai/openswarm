"""A summary that narrates 'a codename was invented' while omitting the codename IS the memory loss.

Live, 2026-09-01, distiller ON, real rebuild: the distill input contained "CODENAME4: Veltrix
Snorbu" in full (p_format_dropped carries assistant text verbatim), the 1,642-char summary said a
codename was invented, and the agent then answered "I do not know" to the recall. The recap drops
model replies by design, so this summary is the ONLY carrier of the agent's own conclusions across a
compaction; a prompt that rewards narration over facts loses exactly the thing it exists to keep.
"""
from backend.apps.agents.manager.session.distill_history import P_SYSTEM, p_format_dropped
from backend.apps.agents.core.models import Message


def test_the_prompt_demands_exact_values_verbatim():
    low = P_SYSTEM.lower()
    assert "verbatim" in low
    assert "character for character" in low
    for word in ("codename", "checksum", "identifier", "decision"):
        assert word in low, f"the prompt must name '{word}' as a thing to preserve"


def test_the_prompt_keeps_the_filter_safe_framing():
    """The aux call rides the same subscription lane as the chat; the hermes-safe 'summarization
    agent creating a context checkpoint' framing replaced wording the provider filter flagged."""
    assert "summarization agent creating a context checkpoint" in P_SYSTEM
    assert "NEVER" not in P_SYSTEM, "the old imperative framing is what got flagged"


def test_the_input_really_carries_assistant_text_in_full():
    """The fix is only meaningful because the value reaches the distiller at all."""
    msgs = [
        Message(role="user", content="invent a codename", branch_id="b"),
        Message(role="assistant", content="CODENAME4: Veltrix Snorbu", branch_id="b"),
    ]
    body = p_format_dropped(msgs)
    assert "Veltrix Snorbu" in body


def test_the_summary_covers_assistant_text_AFTER_the_cutoff():
    """The structural half, distinct from the prompt: the recap never carries model replies, so a
    fact the agent stated after the compaction cutoff was carried by NOBODY on a rebuild. The
    distill span must run through the newest settled assistant message, not stop at the cutoff."""
    import inspect
    from backend.apps.agents.manager.session import distill_history as mod
    src = inspect.getsource(mod.distilled_history_summary)
    assert "p_end" in src and 'role", "") == "assistant"' in src, \
        "the span must extend to the newest assistant message"
    assert "session.compacted_summary_through = p_through" in inspect.getsource(mod), \
        "and the cache must key on that id, or a stale pre-extension summary is served forever"
