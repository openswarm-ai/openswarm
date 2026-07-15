"""Hardened zip <-> bytes for .swarm bundles. The zip arrives from an untrusted
party, so unpack defends against zip-slip, zip-bombs, symlinks, and lying size
headers, and only ever writes into a throwaway sandbox dir (never a real store).
pack re-checks that no secret slipped past redaction before writing a byte."""
from __future__ import annotations

import hashlib
import io
import json
import os
import shutil
import tempfile
import zipfile

from backend.apps.swarm.redact import find_denied_keys, find_secrets_in_files

MANIFEST_NAME = "manifest.json"

MAX_ENTRIES = 5000
MAX_TOTAL_BYTES = 200 * 1024 * 1024      # 200 MB uncompressed
MAX_FILE_BYTES = 25 * 1024 * 1024        # 25 MB per entry
MAX_RATIO = 200                          # uncompressed / compressed per entry


class BundleError(Exception):
    """Bundle is malformed or unsafe. Message is safe to show the user."""


def p_content_digest(entries: dict[str, bytes]) -> str:
    """Order-independent sha256 over every non-manifest entry (path + bytes)."""
    h = hashlib.sha256()
    for path in sorted(entries):
        h.update(path.encode("utf-8"))
        h.update(b"\0")
        h.update(entries[path])
        h.update(b"\0")
    return h.hexdigest()


def pack(manifest: dict, payloads: dict[str, dict], files: dict[str, bytes], allow_file_secrets: bool = False) -> bytes:
    """payloads: bundle_id -> JSON payload (-> entities/<bid>/payload.json).
    files: full zip path -> bytes (e.g. entities/<bid>/files/<rel>).
    allow_file_secrets is a user-confirmed override for the FILE-content heuristic only
    (workspace code trips it on look-alike strings); denied payload fields are our own
    credential store and are never exportable, override or not."""
    for bid, payload in payloads.items():
        leaked = find_denied_keys(payload)
        if leaked:
            raise BundleError(
                f"refusing to export: secret-shaped field(s) in {bid}: {leaked[:3]}"
            )
    if not allow_file_secrets:
        leaky_files = find_secrets_in_files(files)
        if leaky_files:
            raise BundleError(
                f"refusing to export: a secret-shaped value is in {leaky_files[0]}; "
                "remove it (use an environment variable) and try again"
            )
    entries: dict[str, bytes] = {}
    for bid, payload in payloads.items():
        entries[f"entities/{bid}/payload.json"] = json.dumps(payload, indent=2).encode("utf-8")
    for path, data in files.items():
        entries[path] = data
    manifest = {**manifest, "checksum": p_content_digest(entries)}
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(MANIFEST_NAME, json.dumps(manifest, indent=2))
        for path in sorted(entries):
            zf.writestr(path, entries[path])
    return buf.getvalue()


def p_sandbox_entries(sandbox: str) -> dict[str, bytes]:
    """Every file under the sandbox except the manifest, keyed by forward-slash
    relpath so it matches the keys pack() hashed (cross-platform)."""
    out: dict[str, bytes] = {}
    root = os.path.realpath(sandbox)
    for base, p_dirs, fnames in os.walk(root):
        for fn in fnames:
            full = os.path.join(base, fn)
            rel = os.path.relpath(full, root).replace(os.sep, "/")
            if rel == MANIFEST_NAME:
                continue
            with open(full, "rb") as f:
                out[rel] = f.read()
    return out


def verify_checksum(sandbox: str, manifest: dict) -> None:
    """Reject an archive whose contents don't match the checksum the author
    recorded (corruption or tampering). Older bundles without one are allowed."""
    expected = manifest.get("checksum")
    if not expected:
        return
    if p_content_digest(p_sandbox_entries(sandbox)) != expected:
        raise BundleError("this .swarm looks corrupted or was modified")


def p_safe_member_path(name: str, sandbox: str) -> str:
    if name.startswith(("/", "\\")) or (len(name) > 1 and name[1] == ":"):
        raise BundleError("bundle contains an absolute path")
    dest = os.path.realpath(os.path.join(sandbox, name))
    root = os.path.realpath(sandbox)
    if dest != root and not dest.startswith(root + os.sep):
        raise BundleError("bundle contains a path-traversal entry")
    return dest


def is_zip(raw: bytes) -> bool:
    return zipfile.is_zipfile(io.BytesIO(raw))


def has_member(raw: bytes, name: str) -> bool:
    with zipfile.ZipFile(io.BytesIO(raw)) as zf:
        return name in zf.namelist()


def unpack(raw: bytes) -> str:
    """Extract into a fresh sandbox temp dir and return it. Caller deletes it."""
    if len(raw) > MAX_TOTAL_BYTES:
        raise BundleError("bundle is too large")
    try:
        zf = zipfile.ZipFile(io.BytesIO(raw))
    except zipfile.BadZipFile:
        raise BundleError("not a valid .swarm file")
    infos = zf.infolist()
    if len(infos) > MAX_ENTRIES:
        raise BundleError("bundle has too many entries")
    total = 0
    for zi in infos:
        if zi.file_size > MAX_FILE_BYTES:
            raise BundleError("bundle has an oversized entry")
        total += zi.file_size
        if total > MAX_TOTAL_BYTES:
            raise BundleError("bundle is too large uncompressed")
        if zi.compress_size and zi.file_size / zi.compress_size > MAX_RATIO:
            raise BundleError("bundle entry is suspiciously compressed")
        mode = (zi.external_attr >> 16) & 0o170000
        if mode == 0o120000:
            raise BundleError("bundle contains a symlink")

    sandbox = tempfile.mkdtemp(prefix="swarm-import-")
    try:
        written = 0
        for zi in infos:
            if zi.is_dir():
                continue
            dest = p_safe_member_path(zi.filename, sandbox)
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            with zf.open(zi) as src, open(dest, "wb") as out:
                while True:
                    chunk = src.read(65536)
                    if not chunk:
                        break
                    written += len(chunk)
                    if written > MAX_TOTAL_BYTES:
                        raise BundleError("bundle exceeded size during extraction")
                    out.write(chunk)
    except Exception:
        shutil.rmtree(sandbox, ignore_errors=True)
        raise
    return sandbox


def read_manifest(sandbox: str) -> dict:
    path = os.path.join(sandbox, MANIFEST_NAME)
    if not os.path.isfile(path):
        raise BundleError("bundle has no manifest")
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise BundleError("bundle manifest is unreadable")
