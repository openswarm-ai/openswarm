"""A skill export must not ship a venv.

Reported by Haik Decie: exporting a skill with a Python venv failed on a secret-shaped value inside
`.venv/.../packaging/licenses/_spdx.py`. Two stacked bugs; this pins the root cause. The walker
bound `dirs` and never pruned it, so it swept a python3.13 tree with absolute paths baked in, dead
on any other machine, into the bundle. The app exporter has always pruned the same set.
"""

from backend.apps.swarm.entities.skills import read_supporting_files
from backend.apps.outputs.workspace_io import WALK_SKIP_DIRS


def test_a_venv_never_reaches_the_bundle(tmp_path):
    skill = tmp_path / "s"
    (skill / ".venv" / "lib" / "python3.13" / "site-packages").mkdir(parents=True)
    (skill / ".venv" / "lib" / "python3.13" / "site-packages" / "_spdx.py").write_text("x")
    (skill / "node_modules").mkdir()
    (skill / "node_modules" / "big.js").write_text("x")
    (skill / "helper.py").write_text("real content")
    (skill / "SKILL.md").write_text("# skill")

    out = read_supporting_files(str(skill))
    assert "helper.py" in out, "real supporting files must still ship"
    assert not any(".venv" in k for k in out), f"venv leaked: {list(out)}"
    assert not any("node_modules" in k for k in out)
    assert "SKILL.md" not in out


def test_it_prunes_the_same_set_the_app_exporter_does():
    # One definition of "do not ship this", not two that can drift.
    src = open("backend/apps/swarm/entities/skills.py").read()
    assert "WALK_SKIP_DIRS" in src
    assert ".venv" in WALK_SKIP_DIRS and "node_modules" in WALK_SKIP_DIRS
