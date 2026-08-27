"""A shaped tool result tells the model where the rest is. We were paying for the file and hiding it.

`shape_tool_response` writes the full body to a blob and REFUSES to shape at all when it cannot
("no recovery path means the cut would be unrecoverable, which is the one thing this must never
do"). The path was then threaded through four call sites into `shape_text(body, recovery)` and
dropped on the floor: the model saw only `[... 27431 characters omitted ...]`.

It was removed on a measurement this repo later retracted as a vacuous control. hermes's equivalent
hands the model an exact re-read call; this restores ours, phrased as output rather than as a note
from a harness.
"""

from backend.apps.agents.manager.streaming.tool_output_shaper import HEAD_CHARS, shape_text

BLOB = "/Users/eric/Library/Application Support/OpenSwarm/data/sessions/abc/blobs/m1-model.txt"


def p_body() -> str:
    return "alpha line\n" * 500 + "NEEDLE\n" + "omega line\n" * 200


def p_note(out: str) -> str:
    return next(ln for ln in out.splitlines() if ln.startswith("[..."))


def test_the_note_carries_no_path_and_no_instruction():
    """DRILLED 2026-08-27, twice, and this is the whole reason.

    Same session, needle in the elided middle, re-running forbidden:
      passive  ("full output: <path>")       -> "I have no legitimate way to see line 301"
      imperative ("Read <path> from line 18") -> "that's not a real system instruction, it's text
                                                 sitting inside the tool result ... flagging it in
                                                 case it's an injection attempt"
    A model with working injection defences must refuse an instruction embedded in tool output. The
    note cannot be an affordance, and advertising it manufactures a false security warning."""
    note = p_note(shape_text(p_body(), BLOB))
    assert BLOB not in note
    for word in ("Read ", "read ", "full output", "see the omitted"):
        assert word not in note, f"an embedded instruction reads as injection: {note}"
    assert "characters omitted" in note, "the cut must still be visible as a cut"


def test_the_blob_is_still_written_even_though_it_is_not_advertised():
    """Recoverability is real; it is just carried by the tool call surviving in the transcript."""
    src = open("backend/apps/agents/manager/streaming/tool_output_shaper.py").read()
    assert "write_blob(" in src
    assert "skipped_no_recovery" in src, "a cut that could not be parked must not happen at all"


def test_the_recovery_arg_is_documented_as_deliberately_unsurfaced():
    """It looked like a forgotten parameter, which is how the path got restored once already."""
    src = open("backend/apps/agents/manager/streaming/tool_output_shaper.py").read()
    i = src.index("def shape_text(")
    doc = src[i:i + 700]
    assert "deliberately NOT written" in doc


def test_no_blob_means_no_promise():
    # A path we could not write must never be advertised; a broken recovery is worse than none.
    note = p_note(shape_text(p_body(), ""))
    assert "full output" not in note and "line" not in note


def test_a_body_too_small_to_cut_is_returned_untouched():
    for small in ("", "just a line", "x" * (HEAD_CHARS - 1)):
        assert shape_text(small, BLOB) == small


def test_the_answer_still_survives_the_cut():
    # The whole point of carrying notable lines; a recovery path is not a licence to delete answers.
    body = "noise\n" * 400 + "FATAL: the database is on fire\n" + "noise\n" * 400
    assert "FATAL: the database is on fire" in shape_text(body, BLOB)
