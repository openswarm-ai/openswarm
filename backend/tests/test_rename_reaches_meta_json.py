"""Renaming an app must land in its meta.json (ENG-308, Haik 2026-08-14).

`update_output` wrote the record and nothing else, so the UI showed the new name while the file
AGENTS read still held the old one: the user says "the X app" and the agent is looking at something
called something else. The pull direction (`sync_output_from_meta_json`) deliberately only fills
placeholders, so nothing was ever going to reconcile them.
"""

import json
import os

from backend.apps.outputs.outputs import WORKSPACE_DIR, write_meta_json_fields


def p_workspace(tmp_name: str) -> str:
    ws = f"qa-rename-{tmp_name}"
    folder = os.path.join(WORKSPACE_DIR, ws)
    os.makedirs(folder, exist_ok=True)
    return ws


def test_a_rename_lands_in_meta_json():
    ws = p_workspace("basic")
    path = os.path.join(WORKSPACE_DIR, ws, "meta.json")
    with open(path, "w") as f:
        json.dump({"name": "Old Name", "description": "d", "keepme": 1}, f)
    assert write_meta_json_fields(ws, {"name": "New Name"}) is True
    meta = json.load(open(path))
    assert meta["name"] == "New Name"
    assert meta["keepme"] == 1, "a rename must not drop the rest of the file"
    assert meta["description"] == "d"


def test_writing_the_same_name_is_a_no_op():
    ws = p_workspace("noop")
    path = os.path.join(WORKSPACE_DIR, ws, "meta.json")
    with open(path, "w") as f:
        json.dump({"name": "Same"}, f)
    assert write_meta_json_fields(ws, {"name": "Same"}) is False


def test_a_missing_workspace_is_quiet_not_fatal():
    assert write_meta_json_fields("does-not-exist-anywhere", {"name": "x"}) is False
    assert write_meta_json_fields("", {"name": "x"}) is False


def test_a_garbled_meta_json_is_rebuilt_rather_than_crashing():
    ws = p_workspace("garbled")
    path = os.path.join(WORKSPACE_DIR, ws, "meta.json")
    with open(path, "w") as f:
        f.write("{not json at all")
    assert write_meta_json_fields(ws, {"name": "Recovered"}) is True
    assert json.load(open(path))["name"] == "Recovered"


def test_the_update_route_pushes_renames_to_disk():
    import inspect
    from backend.apps.outputs import outputs as mod
    src = inspect.getsource(mod.update_output)
    assert "write_meta_json_fields" in src, "a rename that never reaches disk is the whole bug"
