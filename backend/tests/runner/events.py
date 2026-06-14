"""Wire protocol shared by the parent runner and the subprocess worker.

The worker (running in the *test* venv) writes one JSON object per line to an
inherited pipe FD; the parent (running in the *runner* venv) reads them and
drives the Rich dashboard. This module is deliberately dependency-free (only the
stdlib) so it imports cleanly in *both* venvs — no rich, textual, or pytest.

Ordering guarantee: both control events and streamed ``-s`` output are written
through :func:`emit` to the *same* FD from the *same* process, so an OUTPUT
event always lands between its test's LOGSTART and LOGFINISH.
"""

from __future__ import annotations

import json
import os

# Event types (the "type" field of every framed message).
COLLECTION = "collection"  # {"items": [nodeid, ...]}
LOGSTART = "logstart"      # {"nodeid": ...}
LOGREPORT = "logreport"    # {nodeid, when, passed, failed, skipped, duration, capstdout, capstderr, longreprtext}
LOGFINISH = "logfinish"    # {"nodeid": ...}
OUTPUT = "output"          # {"line": ...}  (streamed -s test output)
COVERAGE = "coverage"      # {"rows": [[rel, stmts, miss, pct], ...], "total": float}
DONE = "done"              # {"code": int}


def emit(fd: int, obj: dict) -> None:
    """Write one framed event to ``fd``. Unbuffered to preserve ordering."""
    data = (json.dumps(obj) + "\n").encode("utf-8")
    os.write(fd, data)
