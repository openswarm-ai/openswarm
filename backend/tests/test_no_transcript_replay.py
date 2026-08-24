"""Nothing bound for a model's context may replay another agent's turns.

ENG-358 removed model-authored prose from the session recap because a `USER:/ASSISTANT:` replay is
the shape Anthropic's filter blocks on the subscription lane. Two renderers kept doing it anyway
(ENG-396) because they were MCP tool results rather than the recap: `ReadTestTranscript` and the
workflow-invoke result, both up to 14,000 chars of another agent's verbatim output.

These pin the property at the shared chokepoint, and that the useful half survives.
"""

import re

from backend.apps.agents.manager.session.history_compaction import render_agent_trail, trail_lines
from backend.apps.workflows.workflows import p_render_test_transcript


class P_Msg:
    def __init__(self, role, content, mid="m"):
        self.role, self.content, self.id, self.hidden = role, content, mid, False


def p_run():
    return [
        P_Msg("user", "find out why the build fails"),
        P_Msg("assistant", "Let me reason about this. I suspect the parser is at fault because..."),
        P_Msg("tool_call", {"tool": "Bash", "input": {"command": "pytest -q"}}),
        P_Msg("tool_result", {"tool_name": "Bash", "text": "3 failed, 12 passed\nFATAL: parser died"}),
        P_Msg("assistant", "Based on my analysis the root cause is the parser's lookahead."),
    ]


ROLE_REPLAY = re.compile(r"^\s*(USER|ASSISTANT|MODEL|AI)\s*:", re.MULTILINE | re.IGNORECASE)


def test_the_renderer_never_emits_a_role_tagged_replay():
    out = p_render_test_transcript(p_run())
    assert not ROLE_REPLAY.search(out), f"role-tagged replay leaked back in:\n{out}"


def test_no_model_authored_prose_survives():
    out = p_render_test_transcript(p_run())
    assert "root cause is the parser" not in out
    assert "I suspect the parser" not in out


def test_the_useful_half_still_survives():
    # A control: the fix would be worthless if it also deleted what the Edit Agent diagnoses from.
    out = p_render_test_transcript(p_run())
    assert "pytest -q" in out, "the command has to survive so the agent can re-run it"
    assert "3 failed" in out and "FATAL" in out, "the verdict is the whole point"
    assert "find out why the build fails" in out, "the user's own words are not model output"


def test_every_renderer_shares_one_definition_of_safe():
    # A safety property with two implementations is one drift away from being none.
    src = open("backend/apps/workflows/workflows.py").read()
    assert "render_agent_trail" in src
    assert 'f"{role}: {text.strip()}"' not in src, "the replay formatter must not come back"


def test_the_invoke_result_no_longer_promises_a_transcript():
    src = open("backend/apps/agents/schedule_mcp_server.py").read()
    assert "=== RUN TRANSCRIPT ===" not in src
    assert "WHAT THE RUN DID" in src


def test_the_trail_is_capped_from_the_tail():
    big = [P_Msg("user", "go")] + [
        P_Msg("tool_call", {"tool": "Bash", "input": {"command": f"step-{i}"}}) for i in range(4000)
    ] + [P_Msg("tool_call", {"tool": "Bash", "input": {"command": "LAST-STEP"}})]
    out = render_agent_trail(big, max_chars=2_000)
    assert len(out) < 2_400
    assert "LAST-STEP" in out, "a run's end is where it succeeds or blows up"


def test_an_empty_run_renders_empty_not_a_frame():
    assert render_agent_trail([]) == ""
    assert trail_lines([]) == []


def test_the_aux_conversation_tail_gists_model_text_and_keeps_the_user_verbatim():
    # Shared by predict_followups AND memory distillation, both aux calls on the user's own lane.
    from backend.apps.agents.manager.predict_followups import conversation_tail, P_MODEL_TEXT_CAP

    class P_Sess:
        pass

    import backend.apps.agents.manager.predict_followups as mod
    sess = P_Sess()
    msgs = [P_Msg("user", "how do I deploy this"),
            P_Msg("assistant", "Here is my full reasoning. " + "z" * 900)]
    orig = mod.get_branch_messages
    mod.get_branch_messages = lambda s: msgs
    try:
        tail = conversation_tail(sess)
    finally:
        mod.get_branch_messages = orig
    assert not ROLE_REPLAY.search(tail), f"role-tagged replay in the aux tail:\n{tail}"
    assert "how do I deploy this" in tail, "the user's own words are what we predict from"
    assert "z" * (P_MODEL_TEXT_CAP + 50) not in tail, "model prose must arrive gisted, not whole"
