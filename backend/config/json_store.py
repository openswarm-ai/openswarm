"""Crash-safe JSON file helpers shared by the on-disk stores (sessions,
dashboards, modes, outputs).

Two jobs:
- `atomic_write_json`: write via a temp file in the same dir + os.replace, so a
  crash or power-loss mid-write can never leave a half-written file that bricks
  the next load.
- `read_json_or_none`: read+parse one file, returning None instead of throwing
  on a garbled/unreadable file, so a single corrupt file can't crash a whole
  load-all path (and take down boot or a page with it).

Settings/seq_log/auth keep their own inlined atomic writers; this is for the
stores that were still doing plain open()+dump().
"""
import json
import logging
import os
import tempfile
import threading
import time

logger = logging.getLogger(__name__)

p_write_lock = threading.Lock()


def atomic_write_json(path: str, payload, *, indent: int = 2) -> None:
    directory = os.path.dirname(path) or "."
    with p_write_lock:
        os.makedirs(directory, exist_ok=True)
        fd, tmp = tempfile.mkstemp(prefix=".tmp-", suffix=".json", dir=directory)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(payload, f, indent=indent)
                # os.replace is atomic for the filename, but the file's data
                # may still be sitting in the page cache when the rename
                # commits. A power loss between rename and the kernel's next
                # writeback can leave a zero-length or torn file even though
                # the rename "succeeded". fsync before the rename is what
                # actually makes this crash-safe.
                f.flush()
                os.fsync(f.fileno())
            # Windows: Defender can briefly hold the destination open; a couple of retries covers every real case.
            for attempt in range(3):
                try:
                    os.replace(tmp, path)
                    p_fsync_dir(directory)
                    return
                except PermissionError:
                    if attempt == 2:
                        raise
                    time.sleep(0.1)
        except Exception:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise


def p_fsync_dir(directory: str) -> None:
    # Best-effort fsync of the parent dir so the rename itself sticks
    # across a crash. POSIX needs this (ext4/xfs/btrfs); Windows doesn't
    # let you open a directory for fsync, so we just skip there. Failing
    # here is non-fatal: the file content is already fsync'd above and
    # the rename has happened in memory.
    try:
        dir_fd = os.open(directory, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(dir_fd)
    except OSError:
        pass
    finally:
        os.close(dir_fd)


def read_json_or_none(path: str) -> dict | None:
    """Parse `path`; return None (and log) on a missing/garbled file rather than
    raising. Schema validation is the caller's job, kept separate so a real
    corruption is skipped while a future-schema file isn't mistaken for one."""
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return None
    except (json.JSONDecodeError, UnicodeDecodeError, OSError) as e:
        logger.warning("Skipping unreadable JSON file %s: %s", os.path.basename(path), e)
        return None
