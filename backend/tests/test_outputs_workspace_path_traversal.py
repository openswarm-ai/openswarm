"""Regression tests for workspace path containment (issue #135).

The Output file endpoints gated writes/reads/deletes with a lexical
`os.path.normpath` prefix check, which does NOT resolve symlinks: a symlink
inside a workspace redirected the operation outside it. `safe_workspace_path`
uses `os.path.realpath` so symlink escapes (and the sibling-prefix collision)
are rejected.

Run:
    cd backend && .venv/bin/python -m pytest tests/test_outputs_workspace_path_traversal.py -v
"""

from __future__ import annotations

import os

import pytest

from backend.apps.outputs.outputs import safe_workspace_path


def test_plain_relative_path_is_allowed(tmp_path):
    ws = tmp_path / "ws"
    ws.mkdir()
    got = safe_workspace_path(str(ws), "sub/file.txt")
    assert got == os.path.realpath(str(ws / "sub" / "file.txt"))


def test_dotdot_escape_is_rejected(tmp_path):
    ws = tmp_path / "ws"
    ws.mkdir()
    (tmp_path / "secret.txt").write_text("s")
    assert safe_workspace_path(str(ws), "../secret.txt") is None


def test_sibling_prefix_collision_is_rejected(tmp_path):
    (tmp_path / "abc").mkdir()
    (tmp_path / "abc-evil").mkdir()
    # Lexically `abc/../abc-evil/x` starts with `.../abc`; realpath + os.sep must reject it.
    assert safe_workspace_path(str(tmp_path / "abc"), "../abc-evil/x") is None


def test_symlink_component_escape_is_rejected(tmp_path):
    """A symlink INSIDE the workspace pointing out of it must not be followed —
    the core #135 bug. Skips where the OS won't let us create a symlink."""
    ws = tmp_path / "ws"
    ws.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.txt").write_text("top secret")
    try:
        os.symlink(str(outside), str(ws / "esc"), target_is_directory=True)
    except (OSError, NotImplementedError) as e:
        pytest.skip(f"symlink creation unavailable: {e}")
    # Lexical normpath would accept `ws/esc/secret.txt`; realpath resolves esc->outside and rejects.
    assert safe_workspace_path(str(ws), "esc/secret.txt") is None


def test_symlinked_base_is_not_false_rejected(tmp_path):
    """A symlink in the BASE path (both sides realpath'd) must still allow
    legitimate in-workspace paths, else macOS /var->/private/var breaks."""
    real = tmp_path / "real_ws"
    real.mkdir()
    link = tmp_path / "linked_ws"
    try:
        os.symlink(str(real), str(link), target_is_directory=True)
    except (OSError, NotImplementedError) as e:
        pytest.skip(f"symlink creation unavailable: {e}")
    got = safe_workspace_path(str(link), "inner/file.txt")
    assert got == os.path.realpath(str(real / "inner" / "file.txt"))
