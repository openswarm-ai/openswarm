"""Orphan app workspaces: list them honestly, delete only what is safe.

ENG-268 stopped delete from LEAVING orphans, but the existing pile (9 folders, ~0.85GB measured on
one machine) is still on disk with nothing surfacing it. This is deliberately a report plus a
one-at-a-time delete rather than a sweep: recover_orphaned_apps re-registers orphans that still
carry a real name, so an unattended cleaner racing it would be two jobs fighting over the same
folder with one of them destroying work the other is restoring.
"""

import json
import os
from typing import Any
import pytest
import backend.config.paths as config_paths


@pytest.fixture()
def dirs(tmp_path: Any, monkeypatch: pytest.MonkeyPatch):
    outputs = tmp_path / "outputs"
    ws = tmp_path / "outputs_workspace"
    outputs.mkdir()
    ws.mkdir()
    monkeypatch.setattr(config_paths, "OUTPUTS_DIR", str(outputs))
    monkeypatch.setattr(config_paths, "OUTPUTS_WORKSPACE_DIR", str(ws))
    import backend.apps.outputs.orphan_workspaces as mod
    monkeypatch.setattr(mod, "OUTPUTS_DIR", str(outputs))
    monkeypatch.setattr(mod, "OUTPUTS_WORKSPACE_DIR", str(ws))
    return outputs, ws


def p_make_ws(ws, wsid: str, name: str, payload_bytes: int = 4096) -> str:
    d = ws / wsid
    (d / "frontend" / "src").mkdir(parents=True)
    (d / "frontend" / "src" / "App.tsx").write_text("x" * payload_bytes, encoding="utf-8")
    (d / "meta.json").write_text(json.dumps({"name": name}), encoding="utf-8")
    return str(d)


def p_make_record(outputs, output_id: str, wsid: str) -> None:
    (outputs / f"{output_id}.json").write_text(
        json.dumps({"id": output_id, "name": "Live app", "workspace_id": wsid}), encoding="utf-8")


def test_a_referenced_workspace_is_never_an_orphan(dirs) -> None:
    outputs, ws = dirs
    p_make_ws(ws, "ws-live", "Live app")
    p_make_record(outputs, "out1", "ws-live")
    from backend.apps.outputs.orphan_workspaces import list_orphan_workspaces
    assert [o.workspace_id for o in list_orphan_workspaces()] == []


def test_an_unreferenced_workspace_is_reported_with_its_size(dirs) -> None:
    outputs, ws = dirs
    p_make_ws(ws, "ws-dead", "Stopwatch", payload_bytes=8192)
    from backend.apps.outputs.orphan_workspaces import list_orphan_workspaces
    got = list_orphan_workspaces()
    assert len(got) == 1
    assert got[0].workspace_id == "ws-dead"
    assert got[0].name == "Stopwatch"
    assert got[0].reclaimable_bytes >= 8192


def test_node_modules_is_excluded_from_the_size(dirs) -> None:
    """It is a symlink farm into a shared cache; counting it promises space that never comes back."""
    outputs, ws = dirs
    d = p_make_ws(ws, "ws-heavy", "Heavy", payload_bytes=1024)
    nm = os.path.join(d, "node_modules", "pkg")
    os.makedirs(nm)
    with open(os.path.join(nm, "big.js"), "w", encoding="utf-8") as f:
        f.write("y" * 500_000)
    from backend.apps.outputs.orphan_workspaces import list_orphan_workspaces
    got = list_orphan_workspaces()[0]
    assert got.reclaimable_bytes < 100_000, "node_modules leaked into the reclaimable figure"


def test_deleting_an_orphan_frees_it(dirs) -> None:
    outputs, ws = dirs
    d = p_make_ws(ws, "ws-dead", "Gone")
    from backend.apps.outputs.orphan_workspaces import delete_orphan_workspace
    freed = delete_orphan_workspace("ws-dead")
    assert freed is not None and freed > 0
    assert not os.path.exists(d)


def test_deleting_a_REFERENCED_workspace_is_refused(dirs) -> None:
    """The one that must never fire: a live app's folder is not an orphan."""
    outputs, ws = dirs
    d = p_make_ws(ws, "ws-live", "Live app")
    p_make_record(outputs, "out1", "ws-live")
    from backend.apps.outputs.orphan_workspaces import delete_orphan_workspace
    assert delete_orphan_workspace("ws-live") is None
    assert os.path.isdir(d), "a referenced workspace was deleted"


def test_an_id_that_escapes_the_root_is_refused(dirs, tmp_path: Any) -> None:
    outputs, ws = dirs
    precious = tmp_path / "precious"
    precious.mkdir()
    (precious / "keep.txt").write_text("do not delete", encoding="utf-8")
    from backend.apps.outputs.orphan_workspaces import delete_orphan_workspace
    assert delete_orphan_workspace("../precious") is None
    assert (precious / "keep.txt").is_file(), "delete escaped the workspace root"
