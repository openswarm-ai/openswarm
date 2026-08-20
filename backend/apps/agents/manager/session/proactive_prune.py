"""The trigger hermes has and we did not (NousResearch/hermes-agent, MIT).

Their own test says our bug out loud: "On large-window models should_compress() (~50% of the
window) rarely fires, so old tool outputs ride in history and are re-sent verbatim on every
subsequent turn." Measured here: our shaping cuts 0.0% at EVERY session size, because the only
lever is a 50KB per-message cap no single tool result reaches, so a 218K-token history ships
untouched right up to a cliff the model chokes at (Haik quits around 149K, below our 180K trigger).

The aging itself was already lifted (aged_recap_lines). What was missing is that it only ran at a
compaction boundary, which on a 1M window almost never arrives. So this is the second, INDEPENDENT
trigger: cheap, deterministic, no LLM call, fired on cost rather than on a percentage of a window
nobody reaches.

One adaptation, because our architecture is not theirs. Hermes owns its message list and rewrites
it in place. Our transcript lives inside the CLI, so the only way to make the provider see an aged
history is to rebuild on a fresh session whose recap is the aged one. The rebuild IS our prune.

That makes hermes's PROMPT-CACHE CONTRACT load-bearing rather than optional: a rebuild busts the
cached prefix, so it commits only when it reclaims enough to be worth that, and then disarms until
history has regrown a full runway. Without both gates this would trade tokens for cache misses and
come out slower.
"""

import logging

from typeguard import typechecked

from backend.apps.agents.core.models import AgentSession
from backend.apps.agents.manager.session.aged_recap_lines import TAIL_BUDGET_CHARS, TAIL_COUNT_FLOOR
from backend.apps.agents.manager.session.history_compaction import get_branch_messages

logger = logging.getLogger(__name__)

# Deliberately NOT a fraction of the context window: that is the mistake this exists to correct.
# A fixed cost trigger fires on a 1M lane and a 200K lane alike, because the tokens cost the same.
PROACTIVE_PRUNE_TOKENS = 60_000

# A rebuild is only worth its cache miss if it reclaims real weight.
MIN_RECLAIM_TOKENS = 20_000

# After a commit, stay disarmed until history has regrown a full trigger-sized runway, so a session
# hovering near the line cannot rebuild every turn.
REARM_GROWTH_TOKENS = PROACTIVE_PRUNE_TOKENS


# What one aged stub costs: the tool name, its arguments capped, and a size note.
STUB_COST_CHARS = 220
CHARS_PER_TOKEN = 4


@typechecked
def p_live_chars(session: AgentSession) -> int:
    """Characters of history that would actually be SENT: everything after the compaction cutoff.

    Compaction only marks a cutoff, it never deletes, so counting the whole message list keeps
    reporting the pre-prune size forever and the rearm gate can never disarm (caught by this
    module's own test). What matters is the live tail, because that is what a rebuild ships.
    """
    msgs = [m for m in get_branch_messages(session) if not getattr(m, "hidden", False)]
    p_cut = getattr(session, "compacted_through_msg_id", None)
    if p_cut:
        for i, m in enumerate(msgs):
            if m.id == p_cut:
                msgs = msgs[i + 1:]
                break
    return sum(len(m.content if isinstance(m.content, str) else str(m.content)) for m in msgs)


@typechecked
def history_tokens(session: AgentSession) -> int:
    """What the conversation itself costs, ignoring framework overhead.

    The reported input total also carries the system prompt, tool schemas and MCP descriptions
    (~35K on a loaded session). None of that is reclaimable by pruning history, so measuring
    reclaim against it overstates the win and would fire this on sessions with nothing to give.
    """
    return p_live_chars(session) // CHARS_PER_TOKEN


@typechecked
def estimate_aged_rebuild_tokens(session: AgentSession) -> int:
    """What the history would cost AFTER an aged rebuild.

    Deliberately not estimate_post_compact_input: that one measures what survives a cutoff that has
    already been marked, so before a commit it reports the whole history and makes every reclaim
    look negative (caught by this module's own tests). This measures the thing we would actually
    send: a verbatim tail inside its budget, plus a one-line stub per older tool result.
    """
    msgs = [m for m in get_branch_messages(session) if not getattr(m, "hidden", False)]
    if not msgs:
        return 0
    p_total = p_live_chars(session)
    p_stubs = STUB_COST_CHARS * max(0, len(msgs) - TAIL_COUNT_FLOOR)
    p_after = min(p_total, TAIL_BUDGET_CHARS + p_stubs)
    return p_after // CHARS_PER_TOKEN


@typechecked
def should_proactively_prune(session: AgentSession) -> bool:
    """True when an aged rebuild would pay for itself right now."""
    p_history = history_tokens(session)
    if p_history < PROACTIVE_PRUNE_TOKENS:
        return False

    # Never duplicate the work the real compaction trigger is about to do anyway; that one reads
    # the reported input, because it is guarding the provider's hard wall rather than our cost.
    from backend.apps.agents.manager.context_budget import compact_trigger_tokens
    if int(session.tokens.get("input", 0) or 0) >= compact_trigger_tokens(session):
        return False

    p_rearm = int(getattr(session, "proactive_prune_rearm_tokens", 0) or 0)
    if p_rearm and p_history < p_rearm:
        return False

    p_after = estimate_aged_rebuild_tokens(session)
    p_reclaim = p_history - p_after
    if p_reclaim < MIN_RECLAIM_TOKENS:
        return False

    logger.info(
        f"proactive prune: {p_history} tokens of history, an aged rebuild reclaims ~{p_reclaim}; committing"
    )
    return True


@typechecked
def arm_proactive_prune(session: AgentSession) -> None:
    """Commit the prune: mark history aged and force the rebuild that actually applies it."""
    from backend.apps.agents.manager.context_budget import maybe_compact
    maybe_compact(session, force=True)
    session.needs_fresh_session = True
    session.proactive_prune_rearm_tokens = (
        estimate_aged_rebuild_tokens(session) + REARM_GROWTH_TOKENS
    )
