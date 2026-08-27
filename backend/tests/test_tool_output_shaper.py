"""The shaper's job is to cut tokens without ever costing an answer.

The measurement that produced it: on 6,389 real tool results a plain head+tail shaper destroys
~100% of answer-shaped lines, which is the same sin as the router shapers we rejected. What makes
this one safe is not the line-matching (a heuristic) but the RECOVERY PATH: nothing is removed
without naming the file that still holds it. These pin both halves, plus the shape rule the CLI
enforces in silence.
"""

import pytest

from backend.tests.log_capture import LogCapture

from backend.apps.agents.manager.streaming.tool_output_shaper import (
    SHAPE_OVER_BYTES, bump_shaping_stat, shape_text, shape_tool_response, shaping_report,
)

HOOK = "backend/apps/agents/manager/streaming/post_tool_hook.py"


def p_big(marker: str = "") -> str:
    return ("a" * 3_000) + f"\n{marker}\n" + ("b" * 5_000)


def test_an_elision_is_marked_and_never_names_the_harness_IN_PROSE():
    """CORRECTED 2026-08-27. This used to also ban the blob PATH, citing "8/8 policy blocks against
    3/8, p=0.026". That measurement is retracted: every treatment run was later in the session than
    every control, and re-running the control late gave 6/7 while interleaved arms were level. What
    it really tested was the phrase "elided by OpenSwarm", which is still banned here.

    Re-run the shaper's own guarantee: it writes the full body to a blob and REFUSES to shape when
    it cannot, so withholding the path was paying for a recovery nobody could use."""
    out = shape_text(p_big(), "/data/blobs/x.txt")
    assert "characters omitted" in out, "a cut must be visible as a cut"
    assert "/data/blobs/x.txt" in out, "the file it already wrote must be reachable"
    note = out[out.index("[..."):out.index("]", out.index("[..."))]
    assert "OpenSwarm" not in note.replace("/data/blobs/x.txt", ""), \
        "the harness may not name ITSELF; a path is data, prose is a confession"


def test_the_answer_line_survives_the_middle():
    out = shape_text(p_big("FATAL: the disk is on fire"), "/b.txt")
    assert "FATAL: the disk is on fire" in out
    assert len(out) < 8_000


def test_head_and_tail_both_survive():
    body = "HEAD-MARKER" + ("x" * 9_000) + "TAIL-MARKER"
    out = shape_text(body, "/b.txt")
    # A verdict lives at the END of a build or test run; head-only threw it away every time.
    assert "HEAD-MARKER" in out and "TAIL-MARKER" in out


def test_a_dict_keeps_its_shape_or_the_cli_drops_it_in_silence():
    # Measured live: a bare string returned for Bash failed the tool's output schema and vanished
    # with no error, so the drill "passed" while the model saw the original bytes.
    src = {"stdout": p_big(), "stderr": "", "interrupted": False, "isImage": False}
    out, before, after = shape_tool_response(src, "/b.txt")
    assert set(out.keys()) == set(src.keys())
    assert out["stderr"] == "" and out["interrupted"] is False
    assert after < before


def test_a_text_block_list_keeps_its_shape():
    src = [{"type": "text", "text": p_big()}]
    out, _, _ = shape_tool_response(src, "/b.txt")
    assert isinstance(out, list) and out[0]["type"] == "text"
    assert len(out[0]["text"]) < 8_000


@pytest.mark.parametrize("small", [
    "tiny",
    {"stdout": "tiny", "stderr": ""},
    [{"type": "text", "text": "tiny"}],
])
def test_below_the_knee_nothing_is_touched(small):
    assert shape_tool_response(small, "/b.txt")[0] is None


@pytest.mark.parametrize("weird", [12345, None, True, {"unknown_field": "x" * 9_000}])
def test_an_unrecognised_shape_is_never_guessed_at(weird):
    # Guessing produces a replacement the CLI discards without a word, which reads as "we shaped it".
    assert shape_tool_response(weird, "/b.txt")[0] is None


def test_the_threshold_is_the_measured_knee_not_a_round_number():
    assert SHAPE_OVER_BYTES == 4_000, \
        "4,000B fires on 5.9% of real results and reclaims 52.8% of tool tokens; moving it needs a new measurement"


def test_it_says_so_when_it_cut_nothing_at_depth():
    class S:
        pass
    s = S()
    for _ in range(45):
        bump_shaping_stat(s, "seen", 1)
    assert "0 of 45" in (shaping_report(s) or "")
    bump_shaping_stat(s, "shaped", 1)
    bump_shaping_stat(s, "bytes_before", 9_000)
    bump_shaping_stat(s, "bytes_after", 2_000)
    assert "7,000 bytes" in (shaping_report(s) or "")


def test_a_shallow_session_says_nothing():
    class S:
        pass
    s = S()
    bump_shaping_stat(s, "seen", 3)
    assert shaping_report(s) is None


def test_the_hook_actually_returns_the_field_the_cli_reads():
    # Wire check: the shaper can be perfect and still reach nobody. The CLI keys on this exact
    # field name inside hookSpecificOutput for PostToolUse; `updatedMCPToolOutput` is MCP-only.
    src = open(HOOK).read()
    assert '"updatedToolOutput"' in src
    assert '"hookEventName": "PostToolUse"' in src
    assert "shape_for_model" in src


def test_the_hook_shapes_the_pristine_response_not_the_flattened_one():
    src = open(HOOK).read()
    assert "p_original_response" in src, \
        "the normalisation flattens lists to a string, which the tool's output schema rejects"
    i_capture = src.index("p_original_response = input_data")
    i_use = src.index("shape_for_model(")
    assert i_capture < i_use


def test_the_off_switch_is_declared_and_announces_itself(monkeypatch):
    from backend.apps.agents.manager.streaming import tool_output_shaper as mod

    class S:
        id = "s1"
    monkeypatch.setenv("OSW_TOOL_SHAPING", "off")
    with LogCapture("backend.apps.agents.manager.streaming.tool_output_shaper") as cap:
        assert mod.shape_for_model(S(), "s1", {"stdout": p_big()}, "m1", "Bash") is None
    assert "OFF" in cap.text, "a guard that stops guarding must say which sessions it stopped protecting"


def test_the_shape_Read_actually_emits_is_handled():
    """Caught by a LIVE drill, not by these tests, which is the lesson.

    Every unit test above was written against the payload shapes I imagined. `Read` nests its body
    under `file.content`, matched none of the flat fields, and a 34,482-byte file went to the model
    completely untouched while the whole suite stayed green. A guard present, reachable, and doing
    nothing is the exact class this module was written to kill.
    """
    src = {"type": "text",
           "file": {"filePath": "/x/payments.log", "content": p_big("ERROR retry_exhausted"), "numLines": 500}}
    out, before, after = shape_tool_response(src, "/b.txt")
    assert out is not None, "the most common large-output tool must not be invisible to the shaper"
    assert set(out.keys()) == set(src.keys()) and set(out["file"]) == set(src["file"])
    assert out["file"]["numLines"] == 500, "siblings of the body are left alone"
    assert "ERROR retry_exhausted" in out["file"]["content"]
    assert after < before


def test_an_unrecognised_big_payload_says_so_instead_of_returning_a_silent_none(monkeypatch):
    """The generalisation of the bug above: we cannot enumerate every tool's shape, so the one thing
    that must never happen again is failing SILENTLY on a big body."""
    from backend.apps.agents.manager.streaming import tool_output_shaper as mod
    from backend.tests.log_capture import LogCapture

    class S:
        id = "s1"

    weird = {"totally": {"unexpected": {"nesting": "z" * 9_000}}}
    with LogCapture("backend.apps.agents.manager.streaming.tool_output_shaper") as cap:
        assert mod.shape_for_model(S(), "s1", weird, "m1", "SomeTool") is None
    assert "unrecognised payload shape" in cap.text
    assert "dict(totally)" in cap.text, "the shape has to be named, or nobody can add the field"


def test_a_small_unrecognised_payload_stays_quiet():
    # The control: most results are tiny and unrecognised, and warning on those would be noise.
    from backend.apps.agents.manager.streaming import tool_output_shaper as mod
    from backend.tests.log_capture import LogCapture

    class S:
        id = "s1"
    with LogCapture("backend.apps.agents.manager.streaming.tool_output_shaper") as cap:
        assert mod.shape_for_model(S(), "s1", {"odd": "tiny"}, "m1", "SomeTool") is None
    assert cap.text == ""
