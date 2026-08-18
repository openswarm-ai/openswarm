import asyncio
import os
from uuid import uuid4

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from backend.apps.outputs import models
from backend.apps.outputs import outputs as outputs_mod
from backend.apps.outputs import path_security
from backend.apps.outputs import workspace_io
from backend.apps.outputs.models import Output, WorkspaceSeedRequest


@pytest.fixture
def output_roots(tmp_path, monkeypatch):
    data_dir = tmp_path / "outputs"
    workspace_dir = tmp_path / "workspaces"
    data_dir.mkdir()
    workspace_dir.mkdir()
    monkeypatch.setattr(workspace_io, "DATA_DIR", str(data_dir))
    monkeypatch.setattr(workspace_io, "OUTPUTS_WORKSPACE_DIR", str(workspace_dir))
    monkeypatch.setattr(outputs_mod, "WORKSPACE_DIR", str(workspace_dir))
    monkeypatch.setattr(models, "OUTPUTS_WORKSPACE_DIR", str(workspace_dir))
    return data_dir, workspace_dir


@pytest.mark.parametrize(
    "bad_id",
    [
        "..",
        "../outside",
        r"..\outside",
        "%2e%2e%2foutside",
        "%252e%252e%255coutside",
        "/absolute/path",
        r"C:\absolute\path",
        "workspace:stream",
        "workspace name",
        "CON",
    ],
)
def test_workspace_ids_reject_traversal_and_absolute_paths(bad_id):
    with pytest.raises(ValidationError):
        WorkspaceSeedRequest(workspace_id=bad_id)


@pytest.mark.parametrize(
    "bad_id",
    ["..", r"..\outside", "%2e%2e%2foutside", "/absolute/path", r"C:\absolute\path"],
)
def test_route_workspace_ids_are_rejected_before_join(output_roots, bad_id):
    with pytest.raises(HTTPException) as exc_info:
        outputs_mod.workspace_folder(bad_id)
    assert exc_info.value.status_code == 403


@pytest.mark.parametrize(
    "bad_id",
    [
        "..",
        "../outside",
        r"..\outside",
        "%2e%2e%2foutside",
        "%252e%252e%255coutside",
        "/absolute/path",
        r"C:\absolute\path",
        "output:stream",
        "output.json",
        "NUL",
    ],
)
def test_output_ids_cannot_escape_metadata_directory(output_roots, bad_id):
    with pytest.raises(ValueError):
        workspace_io.output_metadata_path(bad_id)
    with pytest.raises(HTTPException) as exc_info:
        workspace_io.load(bad_id)
    assert exc_info.value.status_code == 404


@pytest.mark.parametrize("output_id", [uuid4().hex, "session-abc_123"])
def test_normal_output_and_workspace_ids_round_trip(output_roots, output_id):
    _, workspace_dir = output_roots
    workspace_id = f"workspace-{output_id}"
    (workspace_dir / workspace_id).mkdir()
    output = Output(id=output_id, name="Normal", workspace_id=workspace_id)

    workspace_io.save(output)

    loaded = workspace_io.load(output_id)
    assert loaded.id == output_id
    assert loaded.workspace_id == workspace_id
    assert loaded.workspace_path == os.path.abspath(workspace_dir / workspace_id)
    assert workspace_io.app_workspace_dir(output_id) == os.path.abspath(workspace_dir / workspace_id)


@pytest.mark.parametrize(
    "filepath",
    [
        "../workspace-evil/pwn.txt",
        r"..\workspace-evil\pwn.txt",
        "%2e%2e%2fworkspace-evil%2fpwn.txt",
        "%252e%252e%255cworkspace-evil%255cpwn.txt",
    ],
)
def test_file_write_blocks_sibling_prefix_and_encoded_windows_traversal(output_roots, filepath):
    _, workspace_dir = output_roots
    (workspace_dir / "workspace").mkdir()
    sibling = workspace_dir / "workspace-evil"
    sibling.mkdir()

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(outputs_mod.write_workspace_file("workspace", filepath, {"content": "owned"}))

    assert exc_info.value.status_code == 403
    assert not (sibling / "pwn.txt").exists()


def test_file_write_blocks_absolute_path(output_roots):
    _, workspace_dir = output_roots
    (workspace_dir / "workspace").mkdir()
    outside = workspace_dir.parent / "outside.txt"

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(
            outputs_mod.write_workspace_file(
                "workspace", str(outside), {"content": "owned"}
            )
        )

    assert exc_info.value.status_code == 403
    assert not outside.exists()


def test_file_write_allows_normal_nested_path(output_roots):
    _, workspace_dir = output_roots
    workspace = workspace_dir / "workspace-session_123"
    workspace.mkdir()

    result = asyncio.run(
        outputs_mod.write_workspace_file(
            workspace.name, "src/index.ts", {"content": "export {};"}
        )
    )

    assert result == {"ok": True}
    assert (workspace / "src" / "index.ts").read_text(encoding="utf-8") == "export {};"


def test_file_write_rejects_symlink_escape_when_supported(output_roots):
    _, workspace_dir = output_roots
    workspace = workspace_dir / "workspace"
    outside = workspace_dir.parent / "outside"
    workspace.mkdir()
    outside.mkdir()
    try:
        (workspace / "link").symlink_to(outside, target_is_directory=True)
    except OSError as exc:
        pytest.skip(f"symlinks unavailable: {exc}")

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(
            outputs_mod.write_workspace_file(
                workspace.name, "link/pwn.txt", {"content": "owned"}
            )
        )

    assert exc_info.value.status_code == 403
    assert not (outside / "pwn.txt").exists()


def test_walk_directory_never_reads_external_file_symlink(tmp_path, monkeypatch):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "app.py").write_text("print('safe')\n", encoding="utf-8")
    (workspace / "bundle.js").write_text("x" * 17, encoding="utf-8")
    external = tmp_path / "host-secret.txt"
    external.write_text("host secret", encoding="utf-8")
    try:
        (workspace / "leak.txt").symlink_to(external)
    except OSError as exc:
        pytest.skip(f"symlinks unavailable: {exc}")

    monkeypatch.setattr(workspace_io, "P_WALK_MAX_FILE_BYTES", 16)

    files, truncated = workspace_io.walk_directory(str(workspace))

    assert files == {"app.py": "print('safe')\n"}
    assert truncated == {"bundle.js": 17}
    assert "leak.txt" not in files
    assert "leak.txt" not in truncated


def test_walk_directory_rejects_symlink_swapped_in_at_open(tmp_path, monkeypatch):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    candidate = workspace / "checked.txt"
    candidate.write_text("checked content", encoding="utf-8")
    external = tmp_path / "host-secret.txt"
    external.write_text("host secret", encoding="utf-8")
    probe = workspace / "symlink-probe"
    try:
        probe.symlink_to(external)
        probe.unlink()
    except OSError as exc:
        pytest.skip(f"symlinks unavailable: {exc}")

    real_builtin_open = open
    real_os_open = os.open
    real_fdopen = os.fdopen
    candidate_key = os.path.normcase(os.path.abspath(candidate))
    swapped = False
    read_targets = []

    def swap_candidate(path):
        nonlocal swapped
        try:
            path_key = os.path.normcase(os.path.abspath(os.fspath(path)))
        except TypeError:
            return
        if path_key == candidate_key and not swapped:
            candidate.unlink()
            candidate.symlink_to(external)
            swapped = True

    def racing_builtin_open(path, *args, **kwargs):
        swap_candidate(path)
        return real_builtin_open(path, *args, **kwargs)

    def racing_os_open(path, *args, **kwargs):
        swap_candidate(path)
        return real_os_open(path, *args, **kwargs)

    def tracking_fdopen(file_descriptor, *args, **kwargs):
        read_targets.append(path_security.opened_file_path(file_descriptor))
        return real_fdopen(file_descriptor, *args, **kwargs)

    monkeypatch.setattr("builtins.open", racing_builtin_open)
    monkeypatch.setattr(workspace_io.os, "open", racing_os_open)
    monkeypatch.setattr(workspace_io.os, "fdopen", tracking_fdopen)

    files, truncated = workspace_io.walk_directory(str(workspace))

    assert swapped
    assert "checked.txt" not in files
    assert "checked.txt" not in truncated
    assert "host secret" not in "".join(files.values())
    assert os.path.normcase(os.path.realpath(external)) not in {
        os.path.normcase(path) for path in read_targets
    }
