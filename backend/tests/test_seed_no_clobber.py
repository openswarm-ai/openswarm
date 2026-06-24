"""Seed must CREATE, never overwrite. Reopening an app re-POSTs the inline
output.files snapshot, which lags behind whatever the agent last wrote to the
workspace on disk; seeding it back used to revert every edited file while the
agent's new files survived (edits looked half-reverted on the next export).

Path constants are module-level, so (like test_versions) we monkeypatch them
into a temp tree. seed_workspace is async; we drive it with asyncio.run from a
sync test so the suite's bare-async-skip doesn't quietly no-op these."""
import asyncio
import os

import pytest

from backend.apps.outputs import outputs as outputs_mod
from backend.apps.outputs.models import WorkspaceSeedRequest


@pytest.fixture
def ws_root(tmp_path, monkeypatch):
    root = tmp_path / "ws"
    root.mkdir()
    monkeypatch.setattr(outputs_mod, "WORKSPACE_DIR", str(root))
    return root


def _seed(**kw):
    return asyncio.run(outputs_mod.seed_workspace(WorkspaceSeedRequest(**kw)))


def _read(folder, rel):
    with open(os.path.join(folder, rel), encoding="utf-8") as f:
        return f.read()


def test_reopen_seed_preserves_agent_edits(ws_root):
    wsid = "ws-reopen"
    folder = os.path.join(str(ws_root), wsid)
    os.makedirs(os.path.join(folder, "frontend", "src"))
    # v1 on disk, captured into the inline snapshot the editor later autosaves.
    with open(os.path.join(folder, "frontend", "src", "App.tsx"), "w") as f:
        f.write("<h1>v1</h1>")
    snapshot = {"frontend/src/App.tsx": "<h1>v1</h1>"}

    # Agent advances the workspace to v2 on disk: edits a file, adds a new one.
    with open(os.path.join(folder, "frontend", "src", "App.tsx"), "w") as f:
        f.write("<h1>v2 agent</h1>")
    with open(os.path.join(folder, "frontend", "src", "New.tsx"), "w") as f:
        f.write("// new v2 file")

    # Reopen replays the stale snapshot through seed.
    _seed(workspace_id=wsid, files=snapshot, meta={"name": "App"})

    assert _read(folder, "frontend/src/App.tsx") == "<h1>v2 agent</h1>"  # not reverted
    assert os.path.exists(os.path.join(folder, "frontend", "src", "New.tsx"))  # survived


def test_fresh_seed_materializes_saved_files(ws_root):
    wsid = "ws-fresh"
    folder = os.path.join(str(ws_root), wsid)
    _seed(workspace_id=wsid,
          files={"index.html": "<html>saved</html>", "style.css": "body{}"},
          meta={"name": "Flat"})
    assert _read(folder, "index.html") == "<html>saved</html>"
    assert _read(folder, "style.css") == "body{}"


def test_seed_fills_only_missing_files(ws_root):
    wsid = "ws-partial"
    folder = os.path.join(str(ws_root), wsid)
    os.makedirs(folder)
    with open(os.path.join(folder, "keep.txt"), "w") as f:
        f.write("on-disk wins")
    # snapshot wants to change keep.txt AND add gone.txt; only the missing one lands.
    _seed(workspace_id=wsid,
          files={"keep.txt": "snapshot loses", "gone.txt": "recreated"})
    assert _read(folder, "keep.txt") == "on-disk wins"
    assert _read(folder, "gone.txt") == "recreated"
