"""Subprocess entry point that runs pytest in the *test* venv.

Spawned by the parent runner as::

    <venv_python> -m tests.runner._worker <event_fd> <options_json>

with ``cwd`` set to the repo root (PEP 420 makes ``tests.runner`` importable
without an ``__init__.py``, the same trick discovery uses). It registers a thin
pytest plugin that frames every collection/run event as JSON onto ``event_fd``,
optionally streams ``-s`` output through a gutter shim onto the same FD, and (for
``--cov``) measures coverage and emits the computed rows. The parent owns all
Rich rendering — this process imports neither rich nor textual.
"""

from __future__ import annotations

import io
import json
import os
import sys
from io import StringIO

import pytest

from tests.runner import events


class _GutterStream:
    """stdout/stderr shim used in ``-s`` mode.

    Buffers writes and forwards each completed line as an OUTPUT event so the
    parent can rail it under the current test's header. Mirrors the old
    in-process shim, but emits framed events instead of printing.
    """

    def __init__(self, fd: int) -> None:
        self._fd = fd
        self._buf = ""

    def write(self, s) -> int:
        if isinstance(s, bytes):
            s = s.decode("utf-8", "replace")
        self._buf += s
        while "\n" in self._buf:
            line, self._buf = self._buf.split("\n", 1)
            events.emit(self._fd, {"type": events.OUTPUT, "line": line})
        return len(s)

    def flush(self) -> None:
        if self._buf:
            events.emit(self._fd, {"type": events.OUTPUT, "line": self._buf})
            self._buf = ""

    def isatty(self) -> bool:
        return False

    def writable(self) -> bool:
        return True

    def fileno(self):  # some libraries probe this; signal "not a real fd"
        raise io.UnsupportedOperation("fileno")


class _EventEmitter:
    """pytest plugin: forward collection/run hooks as framed events."""

    def __init__(self, fd: int) -> None:
        self._fd = fd

    def pytest_collection_finish(self, session) -> None:
        events.emit(
            self._fd,
            {"type": events.COLLECTION, "items": [item.nodeid for item in session.items]},
        )

    def pytest_runtest_logstart(self, nodeid, location) -> None:
        events.emit(self._fd, {"type": events.LOGSTART, "nodeid": nodeid})

    def pytest_runtest_logreport(self, report) -> None:
        events.emit(
            self._fd,
            {
                "type": events.LOGREPORT,
                "nodeid": report.nodeid,
                "when": report.when,
                "passed": bool(report.passed),
                "failed": bool(report.failed),
                "skipped": bool(report.skipped),
                "duration": float(getattr(report, "duration", 0.0) or 0.0),
                "capstdout": report.capstdout or "",
                "capstderr": report.capstderr or "",
                "longreprtext": report.longreprtext or "",
            },
        )

    def pytest_runtest_logfinish(self, nodeid, location) -> None:
        events.emit(self._fd, {"type": events.LOGFINISH, "nodeid": nodeid})


def _emit_coverage(fd: int, cov, coverage_source: list[str], repo_root: str) -> None:
    """Compute the per-file coverage table and emit it (rendering is the parent's job)."""
    try:
        cov.stop()
        cov.save()
        total = cov.report(file=StringIO())
    except Exception as exc:  # pragma: no cover - defensive
        events.emit(fd, {"type": events.COVERAGE, "error": str(exc)})
        return

    needles = [f"{os.sep}{name}{os.sep}" for name in coverage_source]
    data = cov.get_data()
    rows = []
    for path in data.measured_files():
        if not any(n in path for n in needles):
            continue
        try:
            _, statements, _, missing, _ = cov.analysis2(path)
        except Exception:
            continue
        n = len(statements)
        if n == 0:
            continue
        miss = len(missing)
        pct = (n - miss) / n * 100
        rel = os.path.relpath(path, repo_root)
        rows.append([rel, n, miss, pct])

    events.emit(fd, {"type": events.COVERAGE, "rows": rows, "total": float(total)})


def main(argv: list[str]) -> int:
    fd = int(argv[0])
    opts = json.loads(argv[1])

    pytest_args = opts.get("pytest_args", [])
    no_capture = bool(opts.get("no_capture"))
    cov = bool(opts.get("cov"))
    coverage_source = opts.get("coverage_source") or []
    repo_root = opts.get("repo_root") or os.getcwd()

    cov_obj = None
    if cov:
        import coverage

        cov_obj = coverage.Coverage(source=coverage_source)
        cov_obj.start()

    emitter = _EventEmitter(fd)
    args = ["-o", "addopts=", "-p", "no:terminal", *pytest_args]

    saved_out, saved_err = sys.stdout, sys.stderr
    if no_capture:
        sys.stdout = _GutterStream(fd)
        sys.stderr = _GutterStream(fd)
    try:
        code = int(pytest.main(args, plugins=[emitter]))
    finally:
        if no_capture:
            sys.stdout.flush()
            sys.stderr.flush()
            sys.stdout, sys.stderr = saved_out, saved_err

    if cov_obj is not None:
        _emit_coverage(fd, cov_obj, coverage_source, repo_root)

    events.emit(fd, {"type": events.DONE, "code": code})
    return code


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
