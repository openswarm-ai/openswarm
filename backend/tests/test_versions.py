"""App version history: capture / list / restore / branch round-trips for both
a flat (inline-files) app and a webapp_template (workspace-folder) app, plus the
load-bearing invariants: dedupe of unchanged state, the pre_restore safety net,
.env preserved across restore, and branch producing a fully independent app.

The path constants are module-level, so (like test_swarm_bundle) we monkeypatch
them per test into a temp tree."""
import os

import pytest

from backend.apps.outputs import versions, workspace_io
from backend.apps.outputs.models import Output
from backend.apps.swarm.entities import apps as appmod


@pytest.fixture
def stores(tmp_path, monkeypatch):
    outputs_dir = tmp_path / "outputs"
    ws_dir = tmp_path / "ws"
    ver_dir = tmp_path / "versions"
    for d in (outputs_dir, ws_dir, ver_dir):
        d.mkdir()
    monkeypatch.setattr(workspace_io, "DATA_DIR", str(outputs_dir))
    monkeypatch.setattr(versions, "OUTPUTS_VERSIONS_DIR", str(ver_dir))
    monkeypatch.setattr(versions, "OUTPUTS_WORKSPACE_DIR", str(ws_dir))
    monkeypatch.setattr(appmod, "OUTPUTS_WORKSPACE_DIR", str(ws_dir))
    monkeypatch.setattr(appmod, "OUTPUTS_DIR", str(outputs_dir))
    return ws_dir


def _flat_app(html="<h1>v1</h1>"):
    o = Output(name="Flat", files={"index.html": html})
    workspace_io.save(o)
    return o


def _webapp(ws_dir, files):
    wsid = "wsid1"
    folder = os.path.join(str(ws_dir), wsid)
    os.makedirs(folder, exist_ok=True)
    for rel, content in files.items():
        p = os.path.join(folder, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w") as f:
            f.write(content)
    o = Output(name="Web", workspace_id=wsid)
    workspace_io.save(o)
    return o, folder


def test_flat_capture_list_and_restore(stores):
    o = _flat_app("<h1>v1</h1>")
    v1 = versions.capture(o.id, source="manual", label="v1")
    assert v1 is not None

    o.files = {"index.html": "<h1>v2</h1>"}
    workspace_io.save(o)
    versions.capture(o.id, source="auto", label="made v2")

    assert [v.label for v in versions.list_versions(o.id)] == ["made v2", "v1"]

    # diverge the live state WITHOUT capturing, so restore must back it up.
    o.files = {"index.html": "<h1>v3 uncaptured</h1>"}
    workspace_io.save(o)

    restored = versions.restore(o.id, v1.id)
    assert restored.files["index.html"] == "<h1>v1</h1>"

    after = versions.list_versions(o.id)
    pre = [v for v in after if v.source == "pre_restore"]
    assert len(pre) == 1
    meta = versions.read_manifest(o.id, pre[0].id)
    assert meta["app_meta"]["files"]["index.html"] == "<h1>v3 uncaptured</h1>"


def test_dedupe_unchanged_state(stores):
    o = _flat_app()
    v1 = versions.capture(o.id, label="a")
    v2 = versions.capture(o.id, label="b")  # nothing changed since v1
    assert v1.id == v2.id
    assert len(versions.list_versions(o.id)) == 1


def test_restore_no_redundant_backup_when_current_already_saved(stores):
    o = _flat_app("<h1>v1</h1>")
    versions.capture(o.id, label="v1")
    o.files = {"index.html": "<h1>v2</h1>"}
    workspace_io.save(o)
    v2 = versions.capture(o.id, label="v2")  # live state == latest version
    versions.restore(o.id, v2.id)
    # current already equalled the latest version, so no pre_restore junk.
    assert not any(v.source == "pre_restore" for v in versions.list_versions(o.id))


def test_webapp_restore_preserves_env_and_removes_added_files(stores):
    o, folder = _webapp(stores, {"index.html": "<h1>v1</h1>", "src/app.js": "console.log(1)"})
    with open(os.path.join(folder, ".env"), "w") as f:
        f.write("SECRET=keepme\nFRONTEND_PORT=51000\n")

    v1 = versions.capture(o.id, label="v1")

    with open(os.path.join(folder, "index.html"), "w") as f:
        f.write("<h1>v2</h1>")
    with open(os.path.join(folder, "added.txt"), "w") as f:
        f.write("added later")
    versions.capture(o.id, label="v2")

    versions.restore(o.id, v1.id)

    with open(os.path.join(folder, "index.html")) as f:
        assert f.read() == "<h1>v1</h1>"
    assert not os.path.exists(os.path.join(folder, "added.txt"))
    with open(os.path.join(folder, ".env")) as f:
        assert "SECRET=keepme" in f.read()  # .env never snapshotted, never wiped


def test_branch_makes_independent_app(stores):
    o, _ = _webapp(stores, {"index.html": "<h1>v1</h1>"})
    v1 = versions.capture(o.id, label="v1")

    new_id = versions.branch(o.id, v1.id)
    assert new_id and new_id != o.id

    new_o = workspace_io.load_output(new_id)
    assert new_o is not None
    assert new_o.workspace_id and new_o.workspace_id != o.workspace_id
    assert new_o.name == "Web (copy)"
    assert new_o.session_id is None

    new_folder = os.path.join(str(stores), new_o.workspace_id)
    with open(os.path.join(new_folder, "index.html")) as f:
        assert f.read() == "<h1>v1</h1>"


def test_delete_all_removes_history(stores):
    o = _flat_app()
    versions.capture(o.id, label="v1")
    assert versions.list_versions(o.id)
    versions.delete_all(o.id)
    assert versions.list_versions(o.id) == []


def test_restore_is_undoable(stores):
    """Invariant: after any restore, the state you were on is recoverable (the
    pre_restore backup), so a wrong restore is never a dead end."""
    o = _flat_app("<h1>v1</h1>")
    v1 = versions.capture(o.id, label="v1")
    o.files = {"index.html": "<h1>v2</h1>"}
    workspace_io.save(o)
    versions.capture(o.id, label="v2")
    o.files = {"index.html": "<h1>v3 live</h1>"}  # uncaptured live edit
    workspace_io.save(o)

    versions.restore(o.id, v1.id)
    assert workspace_io.load_output(o.id).files["index.html"] == "<h1>v1</h1>"

    backup = next(v for v in versions.list_versions(o.id) if v.source == "pre_restore")
    versions.restore(o.id, backup.id)
    assert workspace_io.load_output(o.id).files["index.html"] == "<h1>v3 live</h1>"


def test_branch_does_not_mutate_source(stores):
    """Invariant: branching, then editing the copy, never touches the original."""
    o, folder = _webapp(stores, {"index.html": "<h1>source</h1>"})
    v1 = versions.capture(o.id, label="v1")

    new_id = versions.branch(o.id, v1.id)
    new_o = workspace_io.load_output(new_id)
    new_folder = os.path.join(str(stores), new_o.workspace_id)
    with open(os.path.join(new_folder, "index.html"), "w") as f:
        f.write("<h1>changed copy</h1>")

    with open(os.path.join(folder, "index.html")) as f:
        assert f.read() == "<h1>source</h1>"
    assert workspace_io.load_output(o.id).name == "Web"


def test_restore_clears_empty_schema(stores):
    """Regression: an empty {} input_schema must actually restore as empty, not
    fall back to the current one (the falsy-dict bug)."""
    o = Output(name="S", files={"index.html": "x"}, input_schema={})
    workspace_io.save(o)
    v1 = versions.capture(o.id, label="empty schema")
    o.input_schema = {"type": "object", "properties": {"a": {}}, "required": []}
    workspace_io.save(o)
    versions.capture(o.id, label="full schema")

    versions.restore(o.id, v1.id)
    assert workspace_io.load_output(o.id).input_schema == {}


def test_unchanged_files_are_not_duplicated(stores):
    """The whole efficiency point: changing 1 of 10 files across two versions
    adds 1 blob, not 10. Storage is O(unique content), not O(files x versions)."""
    o, folder = _webapp(stores, {f"f{i}.txt": f"content {i}" for i in range(10)})
    versions.capture(o.id, label="v1")
    with open(os.path.join(folder, "f0.txt"), "w") as f:
        f.write("changed")
    versions.capture(o.id, label="v2")

    blobs = os.listdir(versions.blobs_dir(o.id))
    assert len(blobs) == 11  # 10 originals shared + 1 changed; NOT 20


def test_capture_missing_app_returns_none(stores):
    assert versions.capture("does-not-exist") is None
    assert versions.restore("nope", "nope") is None
    assert versions.branch("nope", "nope") is None
    assert versions.list_versions("nope") == []
