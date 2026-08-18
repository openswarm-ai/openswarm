"""Ownership and removal rules for the directories the warm cache creates: every directory we may later
delete carries a marker we wrote, nothing behind a symlink/junction/reparse point is ever trusted, and
removal refuses anything unmarked."""
import json
import os
import shutil
import stat
import time
from contextlib import contextmanager
from pathlib import Path
from typing import BinaryIO, Iterator

from backend.apps.outputs.python_venv.identity import venv_metadata_is_current


OWNER_MARKER = ".openswarm-venv-owner.json"
CACHE_OWNER_MARKER = ".openswarm-cache-owner.json"
OWNER_PAYLOAD = {"owner": "openswarm", "schema": 1}


def path_is_reparse(path: str | Path) -> bool:
    candidate = Path(path)
    try:
        if candidate.is_symlink():
            return True
        is_junction = getattr(candidate, "is_junction", None)
        if callable(is_junction) and is_junction():
            return True
        attributes = getattr(os.lstat(candidate), "st_file_attributes", 0)
    except OSError:
        return False
    return bool(attributes & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0))


def path_exists(path: str | Path) -> bool:
    return os.path.lexists(os.fspath(path))


def assert_normal_directory(path: str | Path, label: str) -> Path:
    candidate = Path(path)
    if path_is_reparse(candidate):
        raise RuntimeError(f"{label} is a symlink, junction, or reparse point: {candidate}")
    if not candidate.is_dir():
        raise RuntimeError(f"{label} is not a directory: {candidate}")
    return candidate


def p_marker_is_valid(path: Path) -> bool:
    if path_is_reparse(path):
        return False
    try:
        return json.loads(path.read_text(encoding="utf-8")) == OWNER_PAYLOAD
    except (OSError, json.JSONDecodeError, TypeError):
        return False


def p_write_marker(path: Path) -> None:
    pending = path.with_name(f"{path.name}.pending-{os.getpid()}-{time.time_ns()}")
    pending.write_text(
        json.dumps(OWNER_PAYLOAD, sort_keys=True, separators=(",", ":")) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    os.replace(pending, path)


def mark_created_venv(venv_dir: str | Path) -> None:
    root = assert_normal_directory(venv_dir, "created virtual environment")
    if not venv_metadata_is_current(root):
        raise RuntimeError("created virtual environment has stale or missing pyvenv.cfg")
    p_write_marker(root / OWNER_MARKER)


def assert_owned_venv(venv_dir: str | Path) -> Path:
    root = assert_normal_directory(venv_dir, "virtual environment")
    if p_marker_is_valid(root / OWNER_MARKER):
        return root
    raise RuntimeError(f"virtual environment is not owned by OpenSwarm: {root}")


def mark_cache_root(cache_dir: str | Path) -> None:
    root = assert_normal_directory(cache_dir, "warm-cache root")
    p_write_marker(root / CACHE_OWNER_MARKER)


def assert_owned_cache_root(cache_dir: str | Path) -> Path:
    root = assert_normal_directory(cache_dir, "warm-cache root")
    if not p_marker_is_valid(root / CACHE_OWNER_MARKER):
        raise RuntimeError(f"warm-cache root is not owned by OpenSwarm: {root}")
    return root


def remove_owned_tree(path: str | Path, *, marker_name: str) -> None:
    root = assert_normal_directory(path, "owned removal target")
    if not p_marker_is_valid(root / marker_name):
        raise RuntimeError(f"refusing to remove unowned directory: {root}")
    shutil.rmtree(root)
    if path_exists(root):
        raise RuntimeError(f"owned directory survived recursive removal: {root}")


@contextmanager
def process_lock(path: str | Path, timeout: float = 120.0) -> Iterator[None]:
    lock_path = Path(path)
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    if path_is_reparse(lock_path):
        raise RuntimeError(f"cache lock is a reparse point: {lock_path}")
    handle = open(lock_path, "a+b")
    acquired = False
    try:
        deadline = time.monotonic() + timeout
        while True:
            try:
                p_lock_handle(handle)
                acquired = True
                break
            except (BlockingIOError, OSError):
                if time.monotonic() >= deadline:
                    raise TimeoutError(f"timed out waiting for cache lock: {lock_path}")
                time.sleep(0.05)
        yield
    finally:
        try:
            if acquired:
                p_unlock_handle(handle)
        finally:
            handle.close()


def p_lock_handle(handle: BinaryIO) -> None:
    if os.name == "nt":
        import msvcrt

        handle.seek(0)
        msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        return
    import fcntl

    fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)


def p_unlock_handle(handle: BinaryIO) -> None:
    if os.name == "nt":
        import msvcrt

        handle.seek(0)
        msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        return
    import fcntl

    fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
