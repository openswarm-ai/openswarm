"""On-disk persistence for outputs: Output JSON records under DATA_DIR and
the workspace file-tree walk used by the polling read endpoint."""

import logging
import os

from fastapi import HTTPException

from backend.apps.outputs.models import Output
from backend.config.paths import OUTPUTS_DIR as DATA_DIR
from backend.config.json_store import read_json_or_none, atomic_write_json

logger = logging.getLogger(__name__)


def _load_all() -> list[Output]:
    result = []
    if not os.path.exists(DATA_DIR):
        return result
    for fname in os.listdir(DATA_DIR):
        if fname.endswith(".json"):
            data = read_json_or_none(os.path.join(DATA_DIR, fname))
            if data is None:
                continue
            try:
                result.append(Output(**data))
            except Exception as e:
                logger.warning("Skipping invalid output file %s: %s", fname, e)
    return result


def _save(output: Output):
    atomic_write_json(os.path.join(DATA_DIR, f"{output.id}.json"), output.model_dump())


def _load(output_id: str) -> Output:
    data = read_json_or_none(os.path.join(DATA_DIR, f"{output_id}.json"))
    if data is None:
        raise HTTPException(status_code=404, detail="Output not found")
    return Output(**data)


def load_output(output_id: str) -> Output | None:
    """Public helper for other modules to resolve an output by ID."""
    data = read_json_or_none(os.path.join(DATA_DIR, f"{output_id}.json"))
    return Output(**data) if data is not None else None


# Build/install/cache directories that the polling endpoint must never
# descend into. Without this skip-list the workspace endpoint reads
# `node_modules/` (300 MB of MUI source, when it's a real dir and not a
# symlink), `.venv/` (10k+ Python files from the hardlinked cache),
# `__pycache__/`, `dist/`, `.git/`, etc; every 2 seconds while the
# agent is active. Result: backend CPU pegged on JSON-serializing
# auto-generated chunks the frontend will then throw away. The frontend
# already filters these for display; this skip is the real fix.
_WALK_SKIP_DIRS = frozenset({
    "node_modules",
    ".vite",
    ".vite-cache",
    ".vite_cache",
    ".git",
    "dist",
    ".next",
    "__pycache__",
    ".venv",
    "venv",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
})

# Poll-payload guard, NOT an editor limit: the workspace endpoint is
# polled every 2 s and re-serializes the whole tree each tick, so a
# multi-MB auto-generated bundle would peg the backend. 2 MB clears every
# realistic hand-authored single-file app while still trapping minified
# bundles/source maps. Oversize files are reported out-of-band (the
# `truncated` map) and NEVER substituted with placeholder content, so a
# marker can't round-trip back into storage and destroy the real source.
_WALK_MAX_FILE_BYTES = 2 * 1024 * 1024


def _walk_directory(folder: str) -> tuple[dict[str, str], dict[str, int]]:
    """Walk a directory tree and return ({relative_path: content}, {relative_path: size}).
    The second map lists files over the cap: they are OMITTED from the
    content map (not stubbed) so no consumer can mistake a placeholder for
    real content. Skips build/install dirs; both critical for the polling
    endpoint, which is called every 2 s while the agent writes code."""
    files: dict[str, str] = {}
    truncated: dict[str, int] = {}
    if not os.path.isdir(folder):
        return files, truncated
    for root, dirs, filenames in os.walk(folder):
        # Mutate `dirs` in place; that's how os.walk skips a subtree.
        # Doing it here means we never even stat the children, so a
        # 10k-file `.venv/` costs ~one stat (on the dir itself) instead
        # of 10k.
        dirs[:] = [d for d in dirs if d not in _WALK_SKIP_DIRS]
        for fname in filenames:
            full_path = os.path.join(root, fname)
            # Normalize to forward-slash keys so the frontend's
            # `path.split('/')` and `.startsWith(prefix)` checks work
            # the same on Windows (where os.sep is '\\') as on macOS.
            # Without this, every workspace file came back as
            # `backend\\app.py` on Windows and the file tree silently
            # mis-parsed.
            rel_path = os.path.relpath(full_path, folder).replace(os.sep, "/")
            try:
                # Stat first; cheap, lets us skip giant files without
                # opening + reading them.
                size = os.path.getsize(full_path)
                if size > _WALK_MAX_FILE_BYTES:
                    truncated[rel_path] = size
                    continue
                with open(full_path) as f:
                    files[rel_path] = f.read()
            except Exception:
                pass
    return files, truncated


def p_would_shrink_oversize_file(full_path: str, incoming: str) -> bool:
    """True when this write would replace a known-oversize file (already past
    the poll cap) with a smaller payload. The polling read omits oversize
    files, so a client never holds their bytes; a smaller write is a
    truncation marker, not a real edit. Refusing it makes the export/snapshot
    corruption impossible at the disk boundary, for any client."""
    if not os.path.isfile(full_path):
        return False
    try:
        existing = os.path.getsize(full_path)
    except OSError:
        return False
    return existing > _WALK_MAX_FILE_BYTES and len(incoming.encode("utf-8")) < existing
