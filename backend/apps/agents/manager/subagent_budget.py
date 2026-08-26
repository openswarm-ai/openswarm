"""How many turns a delegated child gets, in ONE place, and how it is told about them.

A sub-agent used to get a bare 25 with no way to know it. A ten-page transcription burned 37
productive steps (26 reads + 11 commands) and died on the wall having written nothing, while
sibling agents that finished their file left usable output on disk. The budget itself is fine; a
budget nobody can see is not (ENG-409).

The cap lived as a literal `or 25` in two unrelated files, so raising it in one silently left the
other behind. It lives here now.
"""

from typing import Optional

from typeguard import typechecked

# Generous for a lookup, tight for a batch. A child that KNOWS the number can spend it deliberately,
# which is what this file is really for; raising it is a separate decision from surfacing it.
SUBAGENT_MAX_TURNS = 25


@typechecked
def subagent_turn_budget(inherited: Optional[int]) -> int:
    """A child inherits its parent's explicit budget, else the default."""
    return inherited or SUBAGENT_MAX_TURNS


@typechecked
def budget_briefing(turns: int) -> str:
    """One line telling the child what it has, so it can checkpoint instead of being cut off.

    Deliberately phrased as a working instruction rather than a note about the harness: on a lane
    whose terms restrict third-party automated use, describing the machinery is a liability we
    already removed everywhere else (CLAUDE.md, "never announce automation").
    """
    return (
        f"You have about {turns} tool-using steps for this task. Work in that budget: if the job is "
        f"larger, save partial results to disk as you go rather than leaving everything to a final "
        f"step, and say what you completed and what remains."
    )


@typechecked
def out_of_turns_message(turns: int) -> str:
    """What the USER reads when a child runs out, instead of `error_max_turns`."""
    return (
        f"This sub-task used all {turns} of its steps before finishing. Anything it saved along the "
        f"way is on disk; send a message to carry on from where it stopped."
    )
