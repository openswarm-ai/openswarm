"""Every turn ends with a sentence to the user, because our own detector calls a tool-tail a quit.

The turn system prompt steers hard into tools (ShowUI x5, AskUI x3, measured 2026-08-26) while
`P_ANSWER_TOOL_MARKERS` treats a ShowUI/AskUI tail as a real answer and a Bash/Edit tail as a silent
quit. So "end the turn on a tool call" is a shape we taught, and then flagged. The detector is right
(a Bash tail genuinely leaves the user with nothing, and loosening it would trade a visible failure
for a silent one), so the correction belongs in the prompt.

UNMEASURED: reproducing a silent quit on demand needs a session deep enough to cause one, which
`OSW_FAULT` cannot synthesise. This pins the rule, not its effect.
"""

P = "backend/apps/agents/manager/prompt/compose_turn_system_prompt.py"
D = "backend/apps/agents/manager/run/empty_finish.py"


def test_the_prompt_says_a_tool_call_is_never_the_last_thing():
    src = open(P).read()
    assert "A tool call is never the last thing you do." in src


def test_the_rule_lives_with_the_steering_that_created_the_habit():
    # It has to sit inside the rich_ui block; a rule the ShowUI-disabled path never sees would miss
    # exactly the sessions whose tails are Bash and Edit.
    src = open(P).read()
    i_open = src.index("<rich_ui>")
    i_close = src.index("</rich_ui>")
    assert i_open < src.index("A tool call is never the last thing") < i_close


def test_the_detector_was_NOT_loosened():
    # The tempting "fix" is to let a Bash tail count as an answer. That converts a visible quit into
    # a silent one, which is a move DOWN the ladder, not up.
    src = open(D).read()
    i = src.index("P_ANSWER_TOOL_MARKERS = ")
    markers = src[i:src.index("\n", i)]
    for allowed in ("openswarm-ui", "ShowUI", "AskUI", "AskUserQuestion"):
        assert allowed in markers
    for never in ("Bash", "Edit", "Write", "TodoWrite", "Read"):
        assert never not in markers, f"{never} tail is a real quit; it must keep counting as one"
