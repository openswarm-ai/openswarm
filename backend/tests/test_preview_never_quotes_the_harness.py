"""A collapsed card's preview must never read a hidden harness prompt or a system note as if the user typed it."""
from backend.apps.agents.core.models import Message
from backend.apps.agents.core.ws_manager import preview_text


def test_hidden_and_system_tails_are_skipped_for_dicts_and_objects() -> None:
    dicts = [{"role": "user", "content": "build the thing"}, {"role": "user", "content": "Finish the task, then answer in plain text.", "hidden": True}, {"role": "system", "content": "This chat was still running when..."}]
    assert preview_text(dicts) == "build the thing"
    objs = [Message(role="user", content="build the thing", branch_id="main"), Message(role="assistant", content="Done: 3 files.", branch_id="main"), Message(role="user", content="The engine process running you was stopped from outside...", branch_id="main", hidden=True)]
    assert preview_text(objs) == "Done: 3 files."


def test_no_visible_turn_means_no_preview() -> None:
    assert preview_text([{"role": "system", "content": "x"}]) == ""
    assert preview_text([]) == ""
