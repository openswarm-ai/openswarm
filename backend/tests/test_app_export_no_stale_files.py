"""Export must not carry the stale inline output.files snapshot when a workspace
exists. output.files is frozen at creation (v1); the agent edits land on disk
(v2). serialize() used to ship the v1 snapshot alongside the v2 disk copy, so an
imported app reverted every edited file (new files survived since they were never
in the snapshot). With a workspace, disk is the single source of truth; only true
flat apps (no workspace) still carry the inline copy."""
import uuid

import pytest

from backend.apps.outputs import workspace_io
from backend.apps.outputs.models import Output
from backend.apps.swarm.entities import apps as apps_mod
from backend.apps.swarm.entities.apps import AppExportable


class P_Ctx:
    pass


@pytest.fixture
def p_ws_root(tmp_path, monkeypatch):
    root = tmp_path / "ws"
    root.mkdir()
    out = tmp_path / "out"
    out.mkdir()
    monkeypatch.setattr(apps_mod, "OUTPUTS_WORKSPACE_DIR", str(root))
    monkeypatch.setattr(workspace_io, "DATA_DIR", str(out))
    return root


def p_make_app(ws_root, *, workspace: bool) -> str:
    wsid = uuid.uuid4().hex if workspace else None
    if wsid:
        folder = ws_root / wsid
        folder.mkdir()
        (folder / "app.py").write_text("print('v1')\n", newline="\n")
    o = Output(
        name="Demo", description="", icon="view_quilt",
        input_schema={"type": "object", "properties": {}, "required": []},
        files={"app.py": "print('v1')\n"},
        workspace_id=wsid, session_id=None,
    )
    workspace_io.save(o)
    return o.id


def test_workspace_app_export_omits_stale_inline_files(p_ws_root):
    oid = p_make_app(p_ws_root, workspace=True)
    o = workspace_io.load_output(oid)
    folder = p_ws_root / o.workspace_id
    # agent edit -> v2 on disk: modify app.py + add new.py (output.files stays v1)
    # newline="\n": the export is compared byte-for-byte below, and text mode would write CRLF on Windows.
    (folder / "app.py").write_text("print('v2 EDITED')\n", newline="\n")
    (folder / "new.py").write_text("print('v2 NEW')\n", newline="\n")

    exp = AppExportable.load(oid)
    payload = exp.serialize(P_Ctx())
    disk = exp.files()

    # the stale v1 snapshot must NOT ride along
    assert payload["files"] == {}, "workspace app must not export the frozen output.files snapshot"
    # disk (v2) is what travels, both the edit and the new file
    assert disk["workspace/app.py"] == b"print('v2 EDITED')\n"
    assert disk["workspace/new.py"] == b"print('v2 NEW')\n"


def test_flat_app_without_workspace_still_carries_inline_files(p_ws_root):
    oid = p_make_app(p_ws_root, workspace=False)
    exp = AppExportable.load(oid)
    payload = exp.serialize(P_Ctx())
    # no workspace -> inline files ARE the source, must survive export
    assert payload["files"] == {"app.py": "print('v1')\n"}
