"""A custom system prompt must actually bite on the FIRST message (Haik's hackathon blocker).

The prompt was always DELIVERED (verified in the live CLI argv, and the model could quote it when
asked), but it sat mid-prompt between the identity block and the MCP registry, after the whole
default prompt, and the model ignored it: a marker-token drill on the packaged build showed 0/3
arms applying it. Moving it last with explicit operator framing flipped all arms to applied.

These pin the structural half of that fix, the part a unit test can hold: position and framing.
The behavioural half lives in the live drill (scratchpad/sysprompt_test.sh pattern).
"""
from backend.apps.agents.manager.prompt.prompt_context import compose_system_prompt

SESSION = "Always answer in pirate speak."
DEFAULT = "Be helpful and concise."
MODE = "You are in coding mode."


def test_session_prompt_is_the_last_content_in_the_composed_prompt():
    out = compose_system_prompt(DEFAULT, MODE, SESSION, "browser ctx", "mcp ctx", "skills ctx")
    assert out is not None
    assert out.rstrip().endswith(SESSION), "anything after the operator's words dilutes them again"


def test_session_prompt_carries_priority_framing():
    out = compose_system_prompt(DEFAULT, MODE, SESSION)
    assert "highest priority" in out
    assert "your very first reply" in out, "turn one is the reported failure; the framing must name it"
    assert out.index("highest priority") < out.index(SESSION), "the framing introduces the prompt, not trails it"


def test_no_session_prompt_means_no_framing_block():
    out = compose_system_prompt(DEFAULT, MODE, None, "browser ctx")
    assert "highest priority" not in out, "an empty operator block would be framing around nothing"
    assert DEFAULT in out and "browser ctx" in out


def test_default_and_mode_prompts_still_precede_context_blocks():
    out = compose_system_prompt(DEFAULT, MODE, SESSION, "browser ctx", "mcp ctx")
    assert out.index(DEFAULT) < out.index(MODE) < out.index("mcp ctx") < out.index(SESSION)
