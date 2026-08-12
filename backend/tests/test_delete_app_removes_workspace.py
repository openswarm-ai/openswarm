"""Deleting an app must take its source tree with it.

Reported live on 1.7.6-exp.2: delete removed only the record JSON and the versions, so the whole app
(source, dist, .env) stayed on disk with nothing in the UI pointing at it. Measured on one machine:
9 orphans, ~0.85GB. Two problems, not one. It is silent disk growth, and it means a deletion the user
made deliberately did not actually delete anything, which the orphan recoverer can then undo by
re-registering the folder as a fresh app.
"""

import os
from typing import Any
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


def p_client(tmp_path: Any, monkeypatch: pytest.MonkeyPatch) -> tuple[TestClient, str, str]:
    data_dir = tmp_path / "outputs"
    ws_dir = tmp_path / "outputs_workspace"
    data_dir.mkdir()
    ws_dir.mkdir()
    import backend.apps.outputs.outputs as mod
    import backend.apps.outputs.workspace_io as wio
    monkeypatch.setattr(mod, "DATA_DIR", str(data_dir))
    monkeypatch.setattr(mod, "WORKSPACE_DIR", str(ws_dir))
    monkeypatch.setattr(wio, "DATA_DIR", str(data_dir), raising=False)
    app = FastAPI()
    app.include_router(mod.outputs.router, prefix="/api/outputs")
    return TestClient(app), str(data_dir), str(ws_dir)


def p_seed(data_dir: str, ws_dir: str, output_id: str, workspace_id: str) -> str:
    """A record plus a workspace with real content in it, the way a built app looks on disk."""
    ws = os.path.join(ws_dir, workspace_id)
    os.makedirs(os.path.join(ws, "frontend", "src"), exist_ok=True)
    os.makedirs(os.path.join(ws, "frontend", "dist"), exist_ok=True)
    with open(os.path.join(ws, "frontend", "src", "App.tsx"), "w", encoding="utf-8") as f:
        f.write("export default function App() { return null }\n")
    with open(os.path.join(ws, "frontend", "dist", "index.html"), "w", encoding="utf-8") as f:
        f.write("<html></html>\n")
    with open(os.path.join(ws, ".env"), "w", encoding="utf-8") as f:
        f.write("FRONTEND_PORT=50416\n")
    import json
    with open(os.path.join(data_dir, f"{output_id}.json"), "w", encoding="utf-8") as f:
        json.dump({"id": output_id, "name": "Stopwatch", "type": "app",
                   "workspace_id": workspace_id, "files": {}}, f)
    return ws


def test_deleting_an_app_removes_its_workspace_tree(tmp_path: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    client, data_dir, ws_dir = p_client(tmp_path, monkeypatch)
    ws = p_seed(data_dir, ws_dir, "out1", "wsp1")
    assert os.path.isdir(ws)

    assert client.delete("/api/outputs/out1").status_code == 200

    assert not os.path.exists(ws), "the app's source tree survived its own deletion"
    assert not os.path.exists(os.path.join(data_dir, "out1.json"))


def test_deleting_one_app_leaves_every_other_workspace_alone(tmp_path: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    client, data_dir, ws_dir = p_client(tmp_path, monkeypatch)
    doomed = p_seed(data_dir, ws_dir, "out1", "wsp1")
    keeper = p_seed(data_dir, ws_dir, "out2", "wsp2")

    assert client.delete("/api/outputs/out1").status_code == 200

    assert not os.path.exists(doomed)
    assert os.path.isfile(os.path.join(keeper, "frontend", "src", "App.tsx"))


def test_a_record_with_no_workspace_still_deletes_cleanly(tmp_path: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    """Old records and non-app outputs have no workspace_id; delete must not care."""
    client, data_dir, ws_dir = p_client(tmp_path, monkeypatch)
    import json
    with open(os.path.join(data_dir, "out3.json"), "w", encoding="utf-8") as f:
        json.dump({"id": "out3", "name": "A chart", "type": "view", "files": {}}, f)

    assert client.delete("/api/outputs/out3").status_code == 200
    assert not os.path.exists(os.path.join(data_dir, "out3.json"))


def test_a_workspace_id_that_escapes_the_root_is_refused(tmp_path: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    """workspace_id is stored data, and rmtree is not a call to take on trust."""
    client, data_dir, ws_dir = p_client(tmp_path, monkeypatch)
    outside = tmp_path / "precious"
    outside.mkdir()
    (outside / "keep.txt").write_text("do not delete me", encoding="utf-8")
    import json
    with open(os.path.join(data_dir, "out4.json"), "w", encoding="utf-8") as f:
        json.dump({"id": "out4", "name": "Evil", "type": "app",
                   "workspace_id": "../precious", "files": {}}, f)

    assert client.delete("/api/outputs/out4").status_code == 200
    assert (outside / "keep.txt").is_file(), "delete escaped the workspace root"
