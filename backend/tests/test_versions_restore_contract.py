"""Fail-closed manifest and bounded-read contracts for version restore."""

from __future__ import annotations

import builtins
import hashlib
import json
import os
from unittest.mock import Mock

import pytest

from backend.apps.outputs import versions, workspace_io
from backend.apps.outputs.models import Output
from backend.apps.swarm.entities import apps as appmod

RESTORE_HASH_CHUNK_BYTES = 256 * 1024


@pytest.fixture
def stores(tmp_path, monkeypatch):
    outputs_dir = tmp_path / "outputs"
    workspace_dir = tmp_path / "workspace"
    versions_dir = tmp_path / "versions"
    for directory in (outputs_dir, workspace_dir, versions_dir):
        directory.mkdir()
    monkeypatch.setattr(workspace_io, "DATA_DIR", str(outputs_dir))
    monkeypatch.setattr(versions, "OUTPUTS_VERSIONS_DIR", str(versions_dir))
    monkeypatch.setattr(versions, "OUTPUTS_WORKSPACE_DIR", str(workspace_dir))
    monkeypatch.setattr(appmod, "OUTPUTS_WORKSPACE_DIR", str(workspace_dir))
    monkeypatch.setattr(appmod, "OUTPUTS_DIR", str(outputs_dir))
    return workspace_dir


def p_webapp(workspace_dir, files: dict[str, str]):
    workspace_id = "restore-contract"
    folder = os.path.join(str(workspace_dir), workspace_id)
    os.makedirs(folder, exist_ok=True)
    for relative_path, content in files.items():
        destination = os.path.join(folder, relative_path)
        os.makedirs(os.path.dirname(destination), exist_ok=True)
        with open(destination, "w", encoding="utf-8") as handle:
            handle.write(content)
    output = Output(name="Restore contract", workspace_id=workspace_id)
    workspace_io.save(output)
    version = versions.capture(output.id, label="contract")
    assert version is not None
    return output, version, folder


def p_manifest_path(output_id: str, version_id: str) -> str:
    return os.path.join(
        versions.OUTPUTS_VERSIONS_DIR,
        output_id,
        "manifests",
        f"{version_id}.json",
    )


def p_manifest(output_id: str, version_id: str) -> dict:
    with open(p_manifest_path(output_id, version_id), encoding="utf-8") as handle:
        return json.load(handle)


def p_write_manifest(output_id: str, version_id: str, manifest: dict) -> None:
    with open(
        p_manifest_path(output_id, version_id),
        "w",
        encoding="utf-8",
    ) as handle:
        json.dump(manifest, handle)


def p_no_staging(output_id: str) -> bool:
    app_dir = os.path.join(versions.OUTPUTS_VERSIONS_DIR, output_id)
    return not any(name.startswith("restore-stage-") for name in os.listdir(app_dir))


def p_assert_refused(output, version, folder, file_map) -> None:
    manifest = p_manifest(output.id, version.id)
    manifest["files"] = file_map
    p_write_manifest(output.id, version.id, manifest)
    live_path = os.path.join(folder, "same.txt")
    before = open(live_path, "rb").read()
    with pytest.raises(versions.BlobRestoreIntegrityError):
        versions.restore(output.id, version.id)
    assert open(live_path, "rb").read() == before
    assert p_no_staging(output.id)


@pytest.mark.parametrize(
    "alias_kind",
    ["normalized", "unicode-normalized", "casefolded"],
)
def test_restore_rejects_normalized_and_casefolded_path_aliases(
    stores, alias_kind
):
    output, version, folder = p_webapp(
        stores,
        {"same.txt": "same", "other.txt": "other"},
    )
    original = p_manifest(output.id, version.id)["files"]
    same_digest = original["workspace/same.txt"]
    other_digest = original["workspace/other.txt"]

    if alias_kind == "normalized":
        file_map = {
            "workspace/nested/../same.txt": other_digest,
            "workspace/same.txt": same_digest,
        }
    elif alias_kind == "unicode-normalized":
        file_map = {
            "workspace/caf\u00e9.txt": same_digest,
            "workspace/cafe\u0301.txt": other_digest,
        }
    else:
        file_map = {
            "workspace/Case.txt": same_digest,
            "workspace/case.txt": other_digest,
        }
    p_assert_refused(
        output,
        version,
        folder,
        file_map,
    )


@pytest.mark.parametrize(
    "path",
    [
        "workspace/",
        "workspace/./same.txt",
        "workspace/nested//same.txt",
        "workspace/nested\\same.txt",
        "outside/same.txt",
        "workspace/name.",
        "workspace/name ",
        "workspace/file.txt:stream",
        "workspace/CON",
        "workspace/con.txt",
        "workspace/LPT1.log",
        "workspace/CONIN$",
        "workspace/CONOUT$",
        "workspace/COM\u00b9.txt",
        "workspace/LPT\u00b3.log",
        "workspace/control\x1f.txt",
    ],
)
def test_restore_rejects_noncanonical_manifest_entries(
    stores, path
):
    output, version, folder = p_webapp(stores, {"same.txt": "same"})
    digest = p_manifest(output.id, version.id)["files"]["workspace/same.txt"]
    p_assert_refused(
        output,
        version,
        folder,
        {path: digest},
    )


@pytest.mark.parametrize("digest", ["A" * 64, "not-a-digest"])
def test_restore_rejects_invalid_digest_before_blob_access(
    stores, monkeypatch, digest
):
    output, version, folder = p_webapp(stores, {"same.txt": "same"})
    manifest = p_manifest(output.id, version.id)
    manifest["files"] = {"workspace/same.txt": digest}
    p_write_manifest(output.id, version.id, manifest)
    stage = Mock(side_effect=AssertionError("invalid digest reached blob staging"))
    monkeypatch.setattr(versions, "stage_blob_verified", stage)
    with pytest.raises(versions.BlobRestoreIntegrityError):
        versions.restore(output.id, version.id)
    stage.assert_not_called()
    assert open(os.path.join(folder, "same.txt"), encoding="utf-8").read() == "same"
    assert p_no_staging(output.id)


@pytest.mark.parametrize("files", [[], "", 0, None, False])
def test_restore_rejects_falsey_non_object_files_without_mutation(
    stores, files
):
    output, version, folder = p_webapp(stores, {"same.txt": "same"})
    p_assert_refused(output, version, folder, files)


def test_restore_rejects_existing_inode_aliases(stores, monkeypatch):
    output, version, folder = p_webapp(
        stores,
        {"one.txt": "same", "two.txt": "same", "same.txt": "live"},
    )
    one = os.path.join(folder, "one.txt")
    two = os.path.join(folder, "two.txt")
    os.remove(two)
    os.link(one, two)
    with pytest.raises(versions.BlobRestoreIntegrityError):
        versions.restore(output.id, version.id)
    assert os.stat(one).st_ino == os.stat(two).st_ino
    assert p_no_staging(output.id)


class p_BoundedReader:
    def __init__(self, handle, sizes):
        self.handle = handle
        self.sizes = sizes

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return self.handle.__exit__(*args)

    def __getattr__(self, name):
        return getattr(self.handle, name)

    def read(self, size=-1):
        self.sizes.append(size)
        assert 0 < size <= RESTORE_HASH_CHUNK_BYTES
        return self.handle.read(size)


def test_restore_hashes_large_live_destination_in_bounded_chunks(
    stores, monkeypatch
):
    payload = "x" * (512 * 1024 + 17)
    output, version, folder = p_webapp(stores, {"same.txt": payload})
    destination = os.path.join(folder, "same.txt")
    expected = hashlib.sha256(payload.encode()).hexdigest()
    assert p_manifest(output.id, version.id)["files"]["workspace/same.txt"] == expected

    real_open = builtins.open
    read_sizes = []

    def p_open(path, *args, **kwargs):
        handle = real_open(path, *args, **kwargs)
        mode = args[0] if args else kwargs.get("mode", "r")
        if os.fspath(path) == destination and mode == "rb":
            return p_BoundedReader(handle, read_sizes)
        return handle

    monkeypatch.setattr(builtins, "open", p_open)
    monkeypatch.setattr(versions, "capture", lambda *args, **kwargs: None)
    restored = versions.restore(output.id, version.id)
    assert restored is not None
    assert len(read_sizes) >= 3
    assert max(read_sizes) == RESTORE_HASH_CHUNK_BYTES
