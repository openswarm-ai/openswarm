"""Per-app version history, stored the way git stores history: content-addressed.

Each unique file's bytes are written ONCE to a per-app blob store (sha256 name,
zlib-compressed); a version is a tiny manifest mapping path -> blob digest. So a
run that changes one file out of fifty costs one new blob, not fifty, and 500
versions of a barely-changing app stay small. That keeps this feature from
making OpenSwarm feel heavier than it already is. We reuse the .swarm app
serializer (captures flat-inline AND webapp_template workspace apps; skips
node_modules/.venv/dist/.git, excludes .env), but never .swarm's pack() (it
refuses on secret-shaped fields, and a local snapshot must never decline to save
the user's own app). No git binary: it isn't guaranteed on a packaged Mac/Win."""
from __future__ import annotations

import hashlib
import json
import logging
import ntpath
import os
import re
import shutil
import tempfile
import unicodedata
import zlib
from datetime import datetime
from uuid import uuid4

from backend.apps.outputs.models import Output, OutputVersion
from backend.apps.outputs.version_blob_staging import (
    BlobRestoreIntegrityError as BlobRestoreIntegrityError,  # re-export: the restore error is part of this module's API
    stage_blob_verified,
)
from backend.apps.outputs.workspace_io import WALK_SKIP_DIRS, save, load_output
from backend.apps.swarm.entities.apps import AppExportable
from backend.config.paths import OUTPUTS_VERSIONS_DIR, OUTPUTS_WORKSPACE_DIR

logger = logging.getLogger(__name__)

P_MAX_FILE_BYTES = 25 * 1024 * 1024  # don't snapshot giant build artifacts
P_RESTORE_HASH_CHUNK_BYTES = 256 * 1024
P_SHA256_DIGEST = re.compile(r"[0-9a-f]{64}\Z")


class p_NullExportCtx:
    """serialize() wants an ExportContext but apps have no cross-refs to rewrite."""

    def bundle_id_for(self, etype, local_id):  # noqa: ARG002
        return None


P_NULL_CTX = p_NullExportCtx()


def p_app_dir(output_id: str) -> str:
    return os.path.join(OUTPUTS_VERSIONS_DIR, output_id)


def blobs_dir(output_id: str) -> str:
    return os.path.join(p_app_dir(output_id), "blobs")


def p_manifests_dir(output_id: str) -> str:
    return os.path.join(p_app_dir(output_id), "manifests")


def p_digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def p_digest_file(path: str) -> str:
    """Hash a live destination without loading the whole file into memory."""
    hasher = hashlib.sha256()
    with open(path, "rb") as handle:
        while chunk := handle.read(P_RESTORE_HASH_CHUNK_BYTES):
            hasher.update(chunk)
    return hasher.hexdigest()


def p_safe_join(folder: str, rel: str) -> str:
    dest = os.path.realpath(os.path.join(folder, rel))
    root = os.path.realpath(folder)
    if dest != root and not dest.startswith(root + os.sep):
        raise ValueError("version file path escapes the workspace")
    return dest


def p_restore_targets(
    folder: str,
    file_map: object,
) -> dict[str, tuple[str, str]]:
    """Validate the complete manifest before staging or destination mutation."""
    if not isinstance(file_map, dict):
        raise BlobRestoreIntegrityError("restore manifest files must be an object")

    targets: dict[str, tuple[str, str]] = {}
    destination_aliases: set[str] = set()
    existing_inodes: set[tuple[int, int]] = set()
    for key, digest in file_map.items():
        if not isinstance(key, str) or not key.startswith("workspace/"):
            raise BlobRestoreIntegrityError("restore manifest has a non-workspace path")
        rel = key[len("workspace/"):]
        parts = rel.split("/")
        if (
            not rel
            or "\\" in rel
            or "\0" in rel
            or os.path.isabs(rel)
            or any(part in {"", ".", ".."} for part in parts)
            or any(ntpath.isreserved(part) for part in parts)
        ):
            raise BlobRestoreIntegrityError(f"restore manifest path is not canonical: {key!r}")
        if not isinstance(digest, str) or P_SHA256_DIGEST.fullmatch(digest) is None:
            raise BlobRestoreIntegrityError(f"restore manifest digest is invalid for {key!r}")

        try:
            dest = p_safe_join(folder, rel)
        except (OSError, ValueError) as error:
            raise BlobRestoreIntegrityError(
                f"restore manifest path is unsafe: {key!r}"
            ) from error
        destination_alias = unicodedata.normalize("NFC", dest).casefold()
        if destination_alias in destination_aliases:
            raise BlobRestoreIntegrityError("restore manifest destination paths alias")
        destination_aliases.add(destination_alias)

        if os.path.exists(dest):
            if not os.path.isfile(dest):
                raise BlobRestoreIntegrityError(
                    f"restore destination is not a regular file: {key!r}"
                )
            try:
                stat = os.stat(dest)
            except OSError as error:
                raise BlobRestoreIntegrityError(
                    f"restore destination is unreadable: {key!r}"
                ) from error
            inode = (stat.st_dev, stat.st_ino)
            if inode in existing_inodes:
                raise BlobRestoreIntegrityError("restore manifest destinations alias an inode")
            existing_inodes.add(inode)
        targets[rel] = (dest, digest)
    return targets


def p_write_blob(output_id: str, data: bytes, digest: str) -> None:
    """Store bytes once, content-addressed. A blob that already exists is the
    whole point: that's a file unchanged since an earlier version, stored zero
    extra times."""
    path = os.path.join(blobs_dir(output_id), digest)
    if os.path.exists(path):
        return
    os.makedirs(blobs_dir(output_id), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(zlib.compress(data, 6))
    os.replace(tmp, path)


def p_read_blob(output_id: str, digest: str) -> bytes | None:
    try:
        with open(os.path.join(blobs_dir(output_id), digest), "rb") as f:
            return zlib.decompress(f.read())
    except (OSError, zlib.error):
        return None


def read_manifest(output_id: str, version_id: str) -> dict | None:
    try:
        with open(os.path.join(p_manifests_dir(output_id), f"{version_id}.json"), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        return None


def p_latest_manifest(output_id: str) -> dict | None:
    """Newest manifest by write time; only read for the dedupe check so capture
    stays O(1) reads rather than scanning every version's content."""
    folder = p_manifests_dir(output_id)
    if not os.path.isdir(folder):
        return None
    js = [os.path.join(folder, f) for f in os.listdir(folder) if f.endswith(".json")]
    if not js:
        return None
    newest = max(js, key=os.path.getmtime)
    try:
        with open(newest, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        return None


def p_tree_hash(app_meta: dict, file_map: dict[str, str]) -> str:
    """Dedupe key over the snapshot's content: app metadata + path->digest map.
    Cheap because the per-file hashing already happened to name the blobs."""
    h = hashlib.sha256()
    h.update(json.dumps(app_meta, sort_keys=True).encode("utf-8"))
    h.update(b"\0")
    for path in sorted(file_map):
        h.update(path.encode("utf-8"))
        h.update(b"\0")
        h.update(file_map[path].encode("utf-8"))
        h.update(b"\0")
    return h.hexdigest()


def p_snapshot(output: Output) -> tuple[dict, dict[str, bytes]]:
    app = AppExportable(output)
    return app.serialize(P_NULL_CTX), app.files()  # files keyed workspace/<rel>


def list_versions(output_id: str) -> list[OutputVersion]:
    folder = p_manifests_dir(output_id)
    if not os.path.isdir(folder):
        return []
    out: list[OutputVersion] = []
    for fname in os.listdir(folder):
        if not fname.endswith(".json"):
            continue
        m = read_manifest(output_id, fname[:-5])
        if m is None:
            continue
        try:
            out.append(OutputVersion(**m))  # ignores the heavy keys (app_meta, files)
        except Exception:
            logger.warning("skipping unreadable version manifest %s", fname)
    out.sort(key=lambda v: v.created_at, reverse=True)
    return out


def capture(
    output_id: str,
    *,
    source: str = "auto",
    label: str = "",
    thumbnail: str | None = None,
) -> OutputVersion | None:
    """Snapshot current app state. Returns the existing latest version (no new
    manifest) when nothing changed, so unchanged runs don't pile up. None only if
    the app is gone."""
    output = load_output(output_id)
    if output is None:
        return None
    app_meta, files = p_snapshot(output)

    file_map: dict[str, str] = {}
    for path, data in files.items():
        if len(data) > P_MAX_FILE_BYTES:
            continue
        file_map[path] = p_digest(data)
    tree = p_tree_hash(app_meta, file_map)

    latest = p_latest_manifest(output_id)
    parent_id = latest.get("id") if latest else None
    if latest is not None and latest.get("tree_hash") == tree:
        try:
            return OutputVersion(**latest)
        except Exception:
            pass  # corrupt latest: fall through and write a fresh manifest

    for path, data in files.items():
        d = file_map.get(path)
        if d is not None:
            p_write_blob(output_id, data, d)

    vid = uuid4().hex
    manifest = {
        "id": vid,
        "created_at": datetime.now().isoformat(),
        "label": label or "",
        "source": source,
        "parent_id": parent_id,
        "thumbnail": thumbnail if thumbnail is not None else output.thumbnail,
        "tree_hash": tree,
        "app_meta": app_meta,
        "files": file_map,
    }
    os.makedirs(p_manifests_dir(output_id), exist_ok=True)
    dest = os.path.join(p_manifests_dir(output_id), f"{vid}.json")
    tmp = dest + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(manifest, f)
    os.replace(tmp, dest)
    return OutputVersion(**manifest)


def p_restore_workspace(output_id: str, workspace_id: str, file_map: object) -> None:
    """Make the workspace match the snapshot. Deletes current authored files not
    in it, then writes the rest FROM BLOBS, skipping any file already byte-correct
    (so a restore writes only the diff). Keeps the live .env and build/cache dirs.

    Two phases, so a bad blob can never leave a partial tree: EVERY blob the
    restore needs is staged and digest-verified OUTSIDE the workspace FIRST,
    with bounded streamed decompression (per-file uncompressed cap enforced
    while reading; only paths held in memory, never all bytes). Any missing,
    unreadable, oversized, malformed, or digest-mismatched blob raises
    BlobRestoreIntegrityError before the destination is touched - not even the
    workspace directory is created. Only once all blobs are proven does the
    destructive/write phase run; staging is cleaned up on success and failure.
    (A crash mid-write still leaves a mixed tree, but the pre_restore backup
    restore() captures first is the safety net for that.)"""
    folder = os.path.join(OUTPUTS_WORKSPACE_DIR, workspace_id)
    targets = p_restore_targets(folder, file_map)

    # The staging dir lives under the app's VERSION store (never the workspace).
    os.makedirs(p_app_dir(output_id), exist_ok=True)
    staging = tempfile.mkdtemp(prefix="restore-stage-", dir=p_app_dir(output_id))
    staged: dict[str, tuple[str, str]] = {}
    try:
        # Phase 1 (destination untouched): stage + verify every file that needs
        # writing. Files already byte-correct on disk are skipped (neither read
        # from blobs nor rewritten), preserving the diff-only write behavior.
        for rel, (dest, digest) in targets.items():
            if os.path.exists(dest):
                try:
                    if (
                        os.path.getsize(dest) <= P_MAX_FILE_BYTES
                        and p_digest_file(dest) == digest
                    ):
                        continue  # already correct: don't rewrite
                except OSError:
                    pass
            staging_path = os.path.join(staging, f"{len(staged)}.blob")
            stage_blob_verified(
                os.path.join(blobs_dir(output_id), digest), digest, staging_path, P_MAX_FILE_BYTES
            )
            staged[rel] = (dest, staging_path)

        # Phase 2 (mutation): every blob is proven, so NOW create the folder,
        # delete files not in the snapshot, and move the staged bytes in.
        os.makedirs(folder, exist_ok=True)
        for root, dirs, fnames in os.walk(folder):
            dirs[:] = [d for d in dirs if d not in WALK_SKIP_DIRS]
            for fname in fnames:
                if fname == ".env":
                    continue
                full = os.path.join(root, fname)
                rel = os.path.relpath(full, folder).replace(os.sep, "/")
                if rel not in targets:
                    try:
                        os.remove(full)
                    except OSError:
                        pass

        for rel, (dest, staging_path) in staged.items():
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            try:
                os.replace(staging_path, dest)
            except OSError:
                shutil.copyfile(staging_path, dest)  # cross-device fallback
    finally:
        shutil.rmtree(staging, ignore_errors=True)


def restore(output_id: str, version_id: str) -> Output | None:
    """Bring the app back to an earlier version, in place. Saves the current
    state as a pre_restore version first so this is always undoable."""
    output = load_output(output_id)
    if output is None:
        return None
    manifest = read_manifest(output_id, version_id)
    if manifest is None:
        return None

    target_label = manifest.get("label") or "an earlier version"
    capture(output_id, source="pre_restore", label=f"Before restoring '{target_label}'")

    app_meta = manifest.get("app_meta") or {}
    output.name = app_meta.get("name", output.name)
    output.description = app_meta.get("description", output.description)
    output.icon = app_meta.get("icon", output.icon)
    # Presence, not truthiness: a snapshot's empty {} schema must restore as empty.
    if app_meta.get("input_schema") is not None:
        output.input_schema = app_meta["input_schema"]
    output.files = app_meta.get("files") or {}
    if manifest.get("thumbnail") is not None:
        output.thumbnail = manifest["thumbnail"]
    now = datetime.now().isoformat()
    output.updated_at = now
    output.preview_updated_at = now

    if output.workspace_id:
        p_restore_workspace(output_id, output.workspace_id, manifest.get("files"))
    save(output)
    return output


def branch(output_id: str, version_id: str) -> str | None:
    """Make a brand-new app from an earlier version. Reuses the .swarm importer,
    which mints a fresh output id + workspace id and localizes a fresh .env."""
    manifest = read_manifest(output_id, version_id)
    if manifest is None:
        return None
    app_meta = dict(manifest.get("app_meta") or {})
    app_meta["name"] = f"{app_meta.get('name') or 'App'} (copy)"
    files: dict[str, bytes] = {}
    for path, digest in (manifest.get("files") or {}).items():
        data = p_read_blob(output_id, digest)
        if data is not None:
            files[path] = data
    from backend.apps.swarm.exportable import RemapTable
    try:
        return AppExportable.import_(app_meta, files, RemapTable())
    except Exception:
        # A partial import leaves an orphan workspace dir (small); better than a 500.
        logger.exception("branch import failed for %s/%s", output_id, version_id)
        return None


def delete_all(output_id: str) -> None:
    shutil.rmtree(p_app_dir(output_id), ignore_errors=True)
