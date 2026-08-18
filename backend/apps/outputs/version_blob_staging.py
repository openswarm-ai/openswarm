"""Bounded, streamed staging of content-addressed version blobs (D7-PR-1a).

Restore must prove a blob without trusting it: this module decompresses a blob
in chunks to a staging file OUTSIDE the destination workspace, enforcing the
uncompressed-size ceiling WHILE reading (so a corrupted/hostile stream cannot
balloon memory or disk before the digest check) and hashing incrementally. Any
missing, unreadable, oversized, malformed (truncated or trailing bytes), or
digest-mismatched blob raises BlobRestoreIntegrityError, and the partial staging
file is removed. Peak memory is one chunk, never a whole blob."""
from __future__ import annotations

import hashlib
import os
import zlib

P_CHUNK_BYTES = 256 * 1024


class BlobRestoreIntegrityError(Exception):
    """A blob needed for a restore is missing, unreadable, oversized,
    undecompressable, malformed, or its bytes do not match its content-addressed
    digest. Raised to fail a restore loudly instead of writing a
    silently-partial or corrupt workspace tree."""


def p_pump(decomp, chunk: bytes, out, hasher, total: int, max_bytes: int, digest: str) -> int:
    """Feed one compressed chunk through, bounding each output slice to a chunk
    so a high-ratio stream can't expand unboundedly in a single call."""
    data = chunk
    while True:
        piece = decomp.decompress(data, P_CHUNK_BYTES)
        if piece:
            total += len(piece)
            if total > max_bytes:
                raise BlobRestoreIntegrityError(f"blob {digest} exceeds the restore size limit")
            hasher.update(piece)
            out.write(piece)
        data = decomp.unconsumed_tail
        if not data:
            return total


def stage_blob_verified(blob_path: str, digest: str, staging_path: str, max_bytes: int) -> None:
    """Stream-decompress blob_path into staging_path and prove it, or raise."""
    hasher = hashlib.sha256()
    decomp = zlib.decompressobj()
    total = 0
    try:
        with open(blob_path, "rb") as src, open(staging_path, "wb") as out:
            while True:
                chunk = src.read(P_CHUNK_BYTES)
                if not chunk:
                    break
                total = p_pump(decomp, chunk, out, hasher, total, max_bytes, digest)
            if not decomp.eof:
                raise BlobRestoreIntegrityError(f"blob {digest} is truncated or incomplete")
            if decomp.unused_data:
                raise BlobRestoreIntegrityError(f"blob {digest} has trailing data after the stream")
        actual = hasher.hexdigest()
        if actual != digest:
            raise BlobRestoreIntegrityError(f"blob {digest} content digest mismatch (got {actual})")
    except OSError as e:
        p_discard(staging_path)
        raise BlobRestoreIntegrityError(f"blob {digest} is missing or unreadable") from e
    except zlib.error as e:
        p_discard(staging_path)
        raise BlobRestoreIntegrityError(f"blob {digest} failed to decompress") from e
    except BlobRestoreIntegrityError:
        p_discard(staging_path)
        raise


def p_discard(staging_path: str) -> None:
    try:
        os.remove(staging_path)
    except OSError:
        pass
