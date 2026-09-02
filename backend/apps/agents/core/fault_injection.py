"""Deliberate faults, so a guard is proven rather than hoped for.

Half our safety code only runs when something rare goes wrong: a wedged sidecar, a frozen loop,
a provider refusal, a mislabelled 401. Waiting for those in the wild means they are never drilled,
and a guard that never executes is indistinguishable from one that never needed to (the 50KB cap
measured 0.0%, ENG-385; the mid-turn breaker never fires on codex at all, ENG-391).

`OSW_FAULT` is a comma-separated list of faults to arm. Unset in every shipped build, and an
unknown name is ignored rather than guessed at, so a typo can never silently arm nothing while
the drill reports a pass.

    OSW_FAULT=policy_block,auth_401 bash run.sh
"""

import logging
import os
from typing import Set

logger = logging.getLogger(__name__)

# Every fault the harness knows. A name outside this set is a typo, not a feature.
KNOWN_FAULTS: Set[str] = {
    "policy_block",      # the provider declines the request (ENG-383 failover, ENG-387 doors)
    "auth_401",          # a 401 mid-turn (ENG-361 self-heal, ENG-365 must not misread "line 401,")
    "sidecar_wedge",     # a builtin tool never returns (ENG-368 heartbeat ceiling)
    "transport_death",   # the CLI's pipe dies, not the provider (ENG-382 respawn-not-rebuild)
    "empty_finish",      # a turn ends with no answer after tool work (ENG-354, ENG-390)
    "dead_lane",         # the router has already given up on the credential (ENG-414 preflight)
    "cli_context_squeeze",  # a tiny context window, so autocompact thrash is drillable (ENG-418)
    "stale_tool_schema",  # the CLI's deferred-tool 400, byte-real incl. truncation (ENG-394 wall 2)
    "unclassified_error",  # a raw runtime failure no classifier owns, so the snag card is drillable (self-heal audit)
}

# The window `cli_context_squeeze` pretends the model has, and the number is load-bearing.
#
# A turn does not start at zero: system prompt plus ~50 tool schemas cost 30,257 tokens on a plain
# agent session (measured live 2026-08-28). Our compaction trigger is 18% of the window, so below a
# ~168K window the trigger sits UNDER that floor, every turn starts over it, and
# `maybe_break_midturn` correctly refuses forever (a rebuild that failed to shrink must run rather
# than break-loop). A drill there reads as "our valve never fires" about a branch that is inert by
# design: measured, at a 30,000 window the breaker ran 0 times while the CLI thrashed to death.
#
# 250,000 puts the trigger at 45,000, clear of the floor and reachable in a few file reads, so the
# valve is genuinely eligible and its firing means something.
CLI_SQUEEZE_WINDOW = 250_000

# What a turn costs before it does anything, measured. Not a limit; the eligibility arithmetic below.
TURN_BASELINE_TOKENS = 30_257

# Smaller windows are still useful, because they reproduce the CLI's own autocompact thrash on
# demand. They just cannot say anything about OUR breaker, and a drill must never be able to report
# that silently.
VALVE_ELIGIBLE_WINDOW = 170_000


def armed(name: str) -> bool:
    """True when this fault was deliberately armed. Never true in a shipped build."""
    raw = os.environ.get("OSW_FAULT", "")
    if not raw:
        return False
    wanted = {p.strip() for p in raw.split(",") if p.strip()}
    return name in (wanted & KNOWN_FAULTS)


def squeezed_context_window() -> int:
    """The pretend window when `cli_context_squeeze` is armed, else 0.

    It has to be ONE number feeding BOTH the CLI's autocompact and our own compaction trigger, or
    the drill measures a configuration that cannot exist: squeeze only the CLI and it dies at 30K
    while our valve waits for 180K, so "our valve never engaged" would be an artifact of the
    harness rather than a finding about the code."""
    if not armed("cli_context_squeeze"):
        return 0
    raw = os.environ.get("OSW_FAULT_CLI_WINDOW", "").strip()
    n = CLI_SQUEEZE_WINDOW
    if raw:
        try:
            p_n = int(raw)
        except ValueError:
            p_n = 0
        if p_n > 0:
            n = p_n
    if n < VALVE_ELIGIBLE_WINDOW:
        logger.warning(
            "cli_context_squeeze window %d puts the compaction trigger under a turn's ~%d-token "
            "baseline, so OUR mid-turn breaker is INELIGIBLE and cannot fire at any input. This "
            "run can reproduce the CLI's autocompact thrash; it can say nothing about our valve.",
            n, TURN_BASELINE_TOKENS,
        )
    return n


P_FIRED: Set[str] = set()


def armed_once(name: str) -> bool:
    """Fire a recoverable fault exactly ONCE per process.

    A fault that fires on every turn cannot drill a recovery: the retry hits the same wall and the
    drill only ever proves the failure, never the heal. Recoverable classes (a dead pipe, a rotated
    token) want one hit and then a clear road."""
    if not armed(name) or name in P_FIRED:
        return False
    P_FIRED.add(name)
    return True


def reset_fired() -> None:
    """Test-only: forget what has fired so a case can arm the same one-shot again."""
    P_FIRED.clear()


def unknown_faults() -> Set[str]:
    """Names asked for that this build does not know: surfaced loudly so a typo cannot read as a pass."""
    raw = os.environ.get("OSW_FAULT", "")
    if not raw:
        return set()
    return {p.strip() for p in raw.split(",") if p.strip()} - KNOWN_FAULTS


def announce() -> None:
    """Say out loud, once at boot, that this process will inject failures, and name any word that
    armed nothing. Silence here is the exact row-6 shape this module exists to kill: a typo arms
    NOTHING, the drill then exercises the untouched happy path, and the pass is meaningless."""
    raw = os.environ.get("OSW_FAULT", "")
    if not raw.strip():
        return
    live = sorted({p.strip() for p in raw.split(",") if p.strip()} & KNOWN_FAULTS)
    bogus = sorted(unknown_faults())
    logger.warning(
        "OSW_FAULT is set: this process will DELIBERATELY INJECT failures. "
        f"armed={live or 'NOTHING'}"
        + (f"; not a known fault, armed nothing: {bogus}" if bogus else "")
    )


# A KNOWN blind spot, written down rather than discovered again: `empty_finish` cannot drive the
# nudge ladder past rung 1. Swallowing the answer also means the model does no NEW tool work, and
# the ladder's own re-nudge guard (`p_tool_calls <= empty_finish_progress_mark`) correctly refuses
# to nudge again with nothing to show for the last one. Measured live 2026-08-24: two sessions,
# tool_calls 8 == progress_mark 8, ladder stopped at nudge 1 and surfaced honestly. Drilling rung 3
# needs a fault that swallows the answer while the model KEEPS working, which this harness cannot
# yet produce (ENG-399).
UNREACHABLE_WITH = {"empty_finish": "nudge ladder rungs 2 and 3"}
