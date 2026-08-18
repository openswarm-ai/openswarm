"""D7-PR-1a: outputs blob restore must verify content integrity and never write
a silently-partial workspace.

A version blob is content-addressed (sha256 of the decompressed bytes IS its
name). Restore must prove each blob before touching the destination: blobs are
staged OUTSIDE the workspace with bounded, streamed decompression (per-file
uncompressed cap enforced while reading; incremental hashing; only paths kept in
memory), and any missing, unreadable, oversized, malformed, or digest-mismatched
blob raises BlobRestoreIntegrityError before a single destination byte - or even
the destination directory - is created, deleted, or written. Staging is cleaned
up on success and on every failure. The path constants are module-level, so we
monkeypatch them per test into a temp tree (matching test_versions)."""
import hashlib
import os
import zlib

import pytest

from backend.apps.outputs import versions, workspace_io
from backend.apps.outputs.models import Output
from backend.apps.outputs.version_blob_staging import stage_blob_verified
from backend.apps.swarm.entities import apps as appmod


def p_sha(data: bytes) -> str:
    """The content address IS sha256 hexdigest; compute it here rather than
    reaching for the module-private helper (house p-private rule)."""
    return hashlib.sha256(data).hexdigest()


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


def p_webapp(ws_dir, files):
    wsid = "wsid1"
    folder = os.path.join(str(ws_dir), wsid)
    os.makedirs(folder, exist_ok=True)
    for rel, content in files.items():
        p = os.path.join(folder, rel)
        os.makedirs(os.path.dirname(p) or folder, exist_ok=True)
        with open(p, "wb") as f:
            f.write(content.encode("utf-8"))
    o = Output(name="Web", workspace_id=wsid)
    workspace_io.save(o)
    return o, folder


def p_write_ws(folder, rel, content):
    p = os.path.join(folder, rel)
    os.makedirs(os.path.dirname(p) or folder, exist_ok=True)
    with open(p, "wb") as f:
        f.write(content.encode("utf-8"))


def p_blob_path(output_id, content):
    return os.path.join(versions.blobs_dir(output_id), p_sha(content.encode("utf-8")))


def p_no_staging_left(output_id):
    app_dir = os.path.join(versions.OUTPUTS_VERSIONS_DIR, output_id)
    return not any(n.startswith("restore-stage-") for n in os.listdir(app_dir))


# ---- Unit: the staged verified reader is the integrity check ----

def p_stage(o_id, content: bytes, staging, max_bytes=1 << 20, digest=None):
    os.makedirs(str(staging), exist_ok=True)
    dest = os.path.join(str(staging), "staged.bin")
    stage_blob_verified(
        os.path.join(versions.blobs_dir(o_id), digest or p_sha(content)),
        digest or p_sha(content), dest, max_bytes,
    )
    return dest


def test_staged_reader_accepts_a_good_blob(stores, tmp_path):
    o, _ = p_webapp(stores, {"index.html": "hello"})
    versions.capture(o.id, label="v1")
    staged = p_stage(o.id, b"hello", tmp_path / "stage")
    assert open(staged, "rb").read() == b"hello"


def test_staged_reader_raises_on_missing_blob(stores, tmp_path):
    o, _ = p_webapp(stores, {"index.html": "hello"})
    versions.capture(o.id, label="v1")
    os.remove(p_blob_path(o.id, "hello"))
    with pytest.raises(versions.BlobRestoreIntegrityError):
        p_stage(o.id, b"hello", tmp_path / "stage")


def test_staged_reader_raises_on_undecompressable_blob(stores, tmp_path):
    o, _ = p_webapp(stores, {"index.html": "hello"})
    versions.capture(o.id, label="v1")
    with open(p_blob_path(o.id, "hello"), "wb") as f:
        f.write(b"\x00 not a zlib stream")
    with pytest.raises(versions.BlobRestoreIntegrityError):
        p_stage(o.id, b"hello", tmp_path / "stage")


def test_staged_reader_raises_on_digest_mismatch(stores, tmp_path):
    # Non-vacuity anchor: readable, decompressable bytes whose content does NOT
    # match the content address must be refused. Delete the digest comparison and
    # this test fails.
    o, _ = p_webapp(stores, {"index.html": "hello"})
    versions.capture(o.id, label="v1")
    with open(p_blob_path(o.id, "hello"), "wb") as f:
        f.write(zlib.compress(b"tampered payload"))
    with pytest.raises(versions.BlobRestoreIntegrityError):
        p_stage(o.id, b"hello", tmp_path / "stage")


def test_staged_reader_rejects_oversized_and_trailing_and_truncated(stores, tmp_path):
    o, _ = p_webapp(stores, {"index.html": "hello"})
    versions.capture(o.id, label="v1")
    blob = p_blob_path(o.id, "hello")
    # Oversized: the cap is enforced WHILE reading, before any digest check.
    big = zlib.compress(b"A" * 4096)
    with open(blob, "wb") as f:
        f.write(big)
    with pytest.raises(versions.BlobRestoreIntegrityError):
        p_stage(o.id, b"hello", tmp_path / "s1", max_bytes=64)
    # Trailing garbage after a complete zlib stream is malformed, not ignored.
    with open(blob, "wb") as f:
        f.write(zlib.compress(b"hello") + b"trailing-garbage")
    with pytest.raises(versions.BlobRestoreIntegrityError):
        p_stage(o.id, b"hello", tmp_path / "s2")
    # Truncated/incomplete stream is malformed.
    with open(blob, "wb") as f:
        f.write(zlib.compress(b"hello" * 200)[:-7])
    with pytest.raises(versions.BlobRestoreIntegrityError):
        p_stage(o.id, b"hello", tmp_path / "s3")


def test_staged_reader_rejects_trailer_only_truncation(stores, tmp_path):
    # A zlib stream with ONLY its 4-byte Adler-32 trailer removed decompresses to
    # the COMPLETE payload, so the content digest still matches and unused_data is
    # empty. The mid-content-truncation and trailing-data guards do not fire here;
    # this case is caught ONLY by `if not decomp.eof`. Bypassing that check makes
    # this test the one that fails while the digest still matches, so it is the
    # load-bearing pin for the never-reached-eof branch.
    o, _ = p_webapp(stores, {"index.html": "hello"})
    versions.capture(o.id, label="v1")
    full = zlib.compress(b"hello")
    with open(p_blob_path(o.id, "hello"), "wb") as f:
        f.write(full[:-4])  # strip only the Adler-32 trailer; payload stays whole
    with pytest.raises(versions.BlobRestoreIntegrityError):
        p_stage(o.id, b"hello", tmp_path / "trailer")


# ---- Integration: restore fails loud and commits no partial state ----

def p_two_file_v1_then_diverge(stores):
    o, folder = p_webapp(stores, {"a.txt": "a1", "b.txt": "b1"})
    v1 = versions.capture(o.id, label="v1")
    # Diverge the live tree so restore must actually read both blobs, and add a
    # file not in v1 so a leaked partial restore would delete it.
    p_write_ws(folder, "a.txt", "a2")
    p_write_ws(folder, "b.txt", "b2")
    p_write_ws(folder, "c.txt", "c-added")
    return o, folder, v1


def p_assert_diverged_tree_untouched(folder):
    assert open(os.path.join(folder, "a.txt"), "rb").read() == b"a2"
    assert open(os.path.join(folder, "b.txt"), "rb").read() == b"b2"
    assert os.path.exists(os.path.join(folder, "c.txt"))


def test_restore_raises_and_leaves_no_partial_state_on_missing_blob(stores):
    o, folder, v1 = p_two_file_v1_then_diverge(stores)
    os.remove(p_blob_path(o.id, "b1"))
    with pytest.raises(versions.BlobRestoreIntegrityError):
        versions.restore(o.id, v1.id)
    # Mutation proof: a per-file "skip the bad blob, write the rest" restore would
    # have reverted a.txt to a1 and deleted c.txt. Both must be untouched.
    p_assert_diverged_tree_untouched(folder)
    assert p_no_staging_left(o.id)


def test_restore_raises_and_leaves_no_partial_state_on_digest_mismatch(stores):
    o, folder, v1 = p_two_file_v1_then_diverge(stores)
    with open(p_blob_path(o.id, "b1"), "wb") as f:
        f.write(zlib.compress(b"tampered"))
    with pytest.raises(versions.BlobRestoreIntegrityError):
        versions.restore(o.id, v1.id)
    p_assert_diverged_tree_untouched(folder)
    assert p_no_staging_left(o.id)


def test_restore_raises_and_leaves_no_partial_state_on_corrupt_blob(stores):
    o, folder, v1 = p_two_file_v1_then_diverge(stores)
    with open(p_blob_path(o.id, "b1"), "wb") as f:
        f.write(b"\x00not zlib")
    with pytest.raises(versions.BlobRestoreIntegrityError):
        versions.restore(o.id, v1.id)
    p_assert_diverged_tree_untouched(folder)
    assert p_no_staging_left(o.id)


def test_restore_rejects_oversized_blob_and_leaves_no_partial_state(stores, monkeypatch):
    o, folder, v1 = p_two_file_v1_then_diverge(stores)
    # Shrink the cap AFTER capture so an honest blob now exceeds the restore
    # bound; the cap must be enforced while reading, failing the whole restore.
    monkeypatch.setattr(versions, "P_MAX_FILE_BYTES", 1)
    with pytest.raises(versions.BlobRestoreIntegrityError):
        versions.restore(o.id, v1.id)
    p_assert_diverged_tree_untouched(folder)
    assert p_no_staging_left(o.id)


def test_failed_restore_never_creates_an_absent_workspace_dir(stores):
    # Blocker-1 regression: validation failure must not even create the
    # destination directory.
    o, folder, v1 = p_two_file_v1_then_diverge(stores)
    with open(p_blob_path(o.id, "b1"), "wb") as f:
        f.write(zlib.compress(b"tampered"))
    import shutil
    shutil.rmtree(folder)
    with pytest.raises(versions.BlobRestoreIntegrityError):
        versions.restore(o.id, v1.id)
    assert not os.path.exists(folder)
    assert p_no_staging_left(o.id)


def test_multi_blob_restore_stages_to_disk_not_memory(stores, monkeypatch):
    # Aggregate restores hold staged BYTES on disk and only paths in memory: every
    # staged file must exist on disk with its full content BEFORE the destination
    # is touched. Spy on the stager to prove each call produced a disk file.
    o, folder, v1 = p_two_file_v1_then_diverge(stores)
    staged_sizes: list[int] = []
    real = versions.stage_blob_verified

    def p_spy(blob_path, digest, staging_path, max_bytes):
        real(blob_path, digest, staging_path, max_bytes)
        staged_sizes.append(os.path.getsize(staging_path))

    monkeypatch.setattr(versions, "stage_blob_verified", p_spy)
    restored = versions.restore(o.id, v1.id)
    assert restored is not None
    assert sorted(staged_sizes) == [2, 2]  # a1 + b1 staged on disk, one file each
    assert open(os.path.join(folder, "a.txt"), "rb").read() == b"a1"
    assert open(os.path.join(folder, "b.txt"), "rb").read() == b"b1"
    assert p_no_staging_left(o.id)  # staging cleaned on success too


# ---- Positive: valid restores still succeed unchanged ----

def test_valid_single_file_restore_succeeds(stores):
    o, folder = p_webapp(stores, {"index.html": "v1"})
    v1 = versions.capture(o.id, label="v1")
    p_write_ws(folder, "index.html", "v2-live")
    restored = versions.restore(o.id, v1.id)
    assert restored is not None
    assert open(os.path.join(folder, "index.html"), "rb").read() == b"v1"


def test_valid_multi_file_restore_succeeds(stores):
    o, folder, v1 = p_two_file_v1_then_diverge(stores)
    restored = versions.restore(o.id, v1.id)
    assert restored is not None
    assert open(os.path.join(folder, "a.txt"), "rb").read() == b"a1"
    assert open(os.path.join(folder, "b.txt"), "rb").read() == b"b1"
    # c.txt was not in v1, so a correct restore removes it.
    assert not os.path.exists(os.path.join(folder, "c.txt"))
    assert p_no_staging_left(o.id)
