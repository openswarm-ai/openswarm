"""Editing an existing App must bind to its workspace, never seed a dupe.

`app_workspace_dir` is the resolver launch_agent uses to turn a selected App
(Output) id into the cwd it should edit in place. If it returns a real path,
launch sets target_directory and the view-builder seed is skipped; if it
returns None the seed fires and a duplicate "Untitled App" is born (the bug
this locks out). Path constants are module-level, so (like test_seed_no_clobber)
we monkeypatch a temp tree.
"""
import json
import os

import pytest

from backend.apps.outputs import workspace_io as wio
from backend.apps.outputs.models import Output


@pytest.fixture
def out_root(tmp_path, monkeypatch):
    data = tmp_path / "outputs"
    ws = tmp_path / "outputs_workspace"
    data.mkdir()
    ws.mkdir()
    monkeypatch.setattr(wio, "DATA_DIR", str(data))
    monkeypatch.setattr(wio, "OUTPUTS_WORKSPACE_DIR", str(ws))
    return data, ws


def _write_output(data_dir, **kw):
    o = Output(**kw)
    with open(os.path.join(str(data_dir), f"{o.id}.json"), "w") as f:
        json.dump(o.model_dump(), f)
    return o


def test_resolves_existing_app_workspace(out_root):
    data, ws = out_root
    os.makedirs(os.path.join(str(ws), "ws-app"))
    o = _write_output(data, name="Voxelcraft", workspace_id="ws-app")
    assert wio.app_workspace_dir(o.id) == os.path.abspath(os.path.join(str(ws), "ws-app"))


def test_missing_output_returns_none(out_root):
    # Deleted/bogus selection -> no bind -> launch falls through to a normal new build.
    assert wio.app_workspace_dir("doesnotexist") is None


def test_output_without_workspace_returns_none(out_root):
    data, _ = out_root
    o = _write_output(data, name="NoWorkspace", workspace_id=None)
    assert wio.app_workspace_dir(o.id) is None


def test_output_with_vanished_folder_returns_none(out_root):
    data, _ = out_root
    o = _write_output(data, name="Gone", workspace_id="ws-vanished")  # folder never created
    assert wio.app_workspace_dir(o.id) is None
