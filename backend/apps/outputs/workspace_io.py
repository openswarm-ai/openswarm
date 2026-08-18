"""On-disk persistence for outputs: Output JSON records under DATA_DIR and
the workspace file-tree walk used by the polling read endpoint."""

import logging
import os
from typing import Optional

from fastapi import HTTPException

from backend.apps.outputs.models import Output
from backend.apps.outputs.path_security import (
    contained_path,
    opened_file_is_contained,
    validate_output_id,
    workspace_directory,
)
from backend.config.paths import OUTPUTS_DIR as DATA_DIR, OUTPUTS_WORKSPACE_DIR
from backend.config.json_store import read_json_or_none, atomic_write_json

logger = logging.getLogger(__name__)


def output_metadata_path(output_id: str) -> str:
    validate_output_id(output_id)
    return contained_path(DATA_DIR, f"{output_id}.json")


def load_all() -> list[Output]:
    result = []
    if not os.path.exists(DATA_DIR):
        return result
    for fname in os.listdir(DATA_DIR):
        if fname.endswith(".json"):
            try:
                path = output_metadata_path(fname[:-5])
            except ValueError as e:
                logger.warning("Skipping invalid output file %s: %s", fname, e)
                continue
            data = read_json_or_none(path)
            if data is None:
                continue
            try:
                result.append(Output(**data))
            except Exception as e:
                logger.warning("Skipping invalid output file %s: %s", fname, e)
    return result


def save(output: Output):
    atomic_write_json(output_metadata_path(output.id), output.model_dump(exclude={"workspace_path"}))


def load(output_id: str) -> Output:
    try:
        path = output_metadata_path(output_id)
    except (TypeError, ValueError):
        raise HTTPException(status_code=404, detail="Output not found")
    data = read_json_or_none(path)
    if data is None:
        raise HTTPException(status_code=404, detail="Output not found")
    return Output(**data)


def load_output(output_id: str) -> Output | None:
    """Public helper for other modules to resolve an output by ID."""
    try:
        path = output_metadata_path(output_id)
    except (TypeError, ValueError):
        return None
    data = read_json_or_none(path)
    return Output(**data) if data is not None else None


def app_workspace_dir(output_id: str) -> str | None:
    """Resolve an App (Output) id to its on-disk workspace folder, or None if
    the app or its folder is gone. Shared by the prompt-context builder (which
    files the agent should edit) and launch (binds the chat's cwd to the app so
    editing it doesn't seed a duplicate 'Untitled App')."""
    output = load_output(output_id)
    if not output or not output.workspace_id:
        return None
    try:
        path = workspace_directory(OUTPUTS_WORKSPACE_DIR, output.workspace_id)
    except ValueError:
        return None
    return path if os.path.isdir(path) else None


def workspace_root(folder: str) -> str:
    """The canonical form of a workspace folder. Every containment check and
    every path handed back to a caller is anchored here."""
    return os.path.realpath(folder)


def resolve_in_workspace(folder: str, relative_path: str) -> Optional[str]:
    """Resolve `relative_path` under workspace `folder`, or None if it escapes.

    The single containment guard for every workspace read/write/delete.
    `realpath`, never `normpath`: normpath is string math that strolls straight
    through a symlink pointing out of the workspace. Both sides are resolved so
    a symlinked ancestor (macOS `/var` -> `/private/var`, every tempdir) doesn't
    reject a legitimate file. It also compares whole path COMPONENTS, not
    strings: without the trailing separator, workspace `abc` owns `abc-evil`.
    """
    root = workspace_root(folder)
    target = os.path.realpath(os.path.join(root, relative_path))
    if target != root and not target.startswith(root + os.sep):
        return None
    return target


# Build/install/cache directories that the polling endpoint must never descend into. Without this skip-list the workspace endpoint reads `node_modules/` (300 MB of MUI source, when it's a real dir and not a symlink), `.venv/` (10k+ Python files from the hardlinked cache), `__pycache__/`, `dist/`, `.git/`, etc; every 2 seconds while the agent is active. Result: backend CPU pegged on JSON-serializing auto-generated chunks the frontend will then throw away. The frontend already filters these for display; this skip is the real fix.
WALK_SKIP_DIRS = frozenset({
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
    ".openswarm",
})

# OS/editor junk files that ride along in a workspace but are noise in an export.
WALK_SKIP_FILES = frozenset({
    ".DS_Store",
    "Thumbs.db",
})

# Poll-payload guard, NOT an editor limit: the endpoint re-serializes the whole tree every 2 s, so a multi-MB bundle would peg the backend; 2 MB clears real hand-authored apps but traps minified bundles/sourcemaps, which are reported out-of-band (the `truncated` map) and NEVER stubbed, so a placeholder can't round-trip back into storage and destroy the real source.
P_WALK_MAX_FILE_BYTES = 2 * 1024 * 1024


def walk_directory(folder: str) -> tuple[dict[str, str], dict[str, int]]:
    """Walk a directory tree and return ({relative_path: content}, {relative_path: size}).
    The second map lists files over the cap: they are OMITTED from the
    content map (not stubbed) so no consumer can mistake a placeholder for
    real content. Skips build/install dirs; both critical for the polling
    endpoint, which is called every 2 s while the agent writes code."""
    files: dict[str, str] = {}
    truncated: dict[str, int] = {}
    if not os.path.isdir(folder):
        return files, truncated
    resolved_folder = os.path.realpath(os.path.abspath(folder))
    open_flags = os.O_RDONLY | getattr(os, "O_BINARY", 0)
    for root, dirs, filenames in os.walk(folder):
        # Mutate `dirs` in place; that's how os.walk skips a subtree. Doing it here means we never even stat the children, so a 10k-file `.venv/` costs ~one stat (on the dir itself) instead of 10k.
        dirs[:] = [d for d in dirs if d not in WALK_SKIP_DIRS]
        for fname in filenames:
            if fname in WALK_SKIP_FILES:
                continue
            full_path = os.path.join(root, fname)
            # Normalize to forward-slash keys so the frontend's `path.split('/')` and `.startsWith(prefix)` checks work the same on Windows (where os.sep is '\\') as on macOS. Without this, every workspace file came back as `backend\\app.py` on Windows and the file tree silently mis-parsed.
            rel_path = os.path.relpath(full_path, folder).replace(os.sep, "/")
            file_descriptor = None
            try:
                file_descriptor = os.open(full_path, open_flags)
                if not opened_file_is_contained(resolved_folder, file_descriptor):
                    continue
                size = os.fstat(file_descriptor).st_size
                if size > P_WALK_MAX_FILE_BYTES:
                    truncated[rel_path] = size
                    continue
                stream = os.fdopen(file_descriptor)
                file_descriptor = None
                with stream as f:
                    files[rel_path] = f.read()
            except Exception:
                pass
            finally:
                if file_descriptor is not None:
                    os.close(file_descriptor)
    return files, truncated


def would_shrink_oversize_file(full_path: str, incoming: str) -> bool:
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
    return existing > P_WALK_MAX_FILE_BYTES and len(incoming.encode("utf-8")) < existing
