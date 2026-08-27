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


def test_the_note_names_the_file_the_shaper_already_wrote():
    assert BLOB in p_note(shape_text(p_body(), BLOB))


def test_it_says_where_in_that_file_the_omitted_part_begins():
    # hermes's trick: without a starting offset the model's first read lands in text it already has.
    body = p_body()
    expected = body.count("\n", 0, HEAD_CHARS) + 1
    assert f"starts at line {expected}" in p_note(shape_text(body, BLOB))


def test_the_notes_PROSE_names_nothing_about_the_harness():
    """The reason the path left in the first place, stated precisely.

    On a packaged install the blob really does live under `.../Application Support/OpenSwarm/data`,
    so the app name is unavoidably inside the path. That is a filesystem fact any `ls` would print,
    and it is a different thing from prose announcing the harness ("elided by OpenSwarm"), which is
    what the original wording did and what the rule is actually about. So: the PATH may say
    anything, the WORDS around it may not."""
    out = shape_text(p_body(), BLOB)
    i = out.index("[...")
    note = out[i:out.index("]", i)]
    prose = note.replace(BLOB, "<path>").lower()
    for word in ("openswarm", "harness", "elided by", "automated", "assistant", "we ", "our "):
        assert word not in prose, f"the note's prose must not say {word!r}: {prose}"
    assert "<path>" in prose, "and the path itself must still be there"


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
