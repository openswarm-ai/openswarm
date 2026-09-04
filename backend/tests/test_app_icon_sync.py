"""meta.json is the agent's channel for an app's icon: a new emoji there lands on the row, a word does not."""
import json
import os
import uuid

from backend.apps.outputs import outputs as outputs_mod
from backend.apps.outputs.models import Output
from backend.apps.outputs.outputs import WORKSPACE_DIR, sync_output_from_meta_json


def workspace_with_meta(meta: dict) -> str:
    ws = "icontest-" + uuid.uuid4().hex[:8]
    folder = os.path.join(WORKSPACE_DIR, ws)
    os.makedirs(folder, exist_ok=True)
    with open(os.path.join(folder, "meta.json"), "w") as f:
        json.dump(meta, f)
    return ws


def make_row(ws: str, name: str = "Doodle Jumper") -> Output:
    return Output(id=uuid.uuid4().hex, name=name, workspace_id=ws)


def test_an_emoji_in_meta_json_lands_on_the_row_and_is_broadcast_worthy(monkeypatch):
    ws = workspace_with_meta({"name": "Doodle Jumper", "icon": "🦘"})
    row = make_row(ws)
    saved = []
    monkeypatch.setattr(outputs_mod, "load_all", lambda: [row])
    monkeypatch.setattr(outputs_mod, "save", lambda o: saved.append(o.icon))
    assert sync_output_from_meta_json(ws) is True
    assert row.icon == "🦘"
    assert saved == ["🦘"]


def test_a_word_or_icon_name_in_meta_json_changes_nothing(monkeypatch):
    ws = workspace_with_meta({"name": "Doodle Jumper", "icon": "rocket"})
    row = make_row(ws)
    monkeypatch.setattr(outputs_mod, "load_all", lambda: [row])
    monkeypatch.setattr(outputs_mod, "save", lambda o: (_ for _ in ()).throw(AssertionError("must not save")))
    assert sync_output_from_meta_json(ws) is False
    assert row.icon == "view_quilt"


def test_the_same_emoji_again_is_a_no_op(monkeypatch):
    ws = workspace_with_meta({"name": "Doodle Jumper", "icon": "🦘"})
    row = make_row(ws)
    row.icon = "🦘"
    monkeypatch.setattr(outputs_mod, "load_all", lambda: [row])
    monkeypatch.setattr(outputs_mod, "save", lambda o: (_ for _ in ()).throw(AssertionError("must not save")))
    assert sync_output_from_meta_json(ws) is False
