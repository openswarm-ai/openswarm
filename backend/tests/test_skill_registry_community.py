"""skills.sh wild-registry resolution + safe install.

The network parts (GitHub trees + raw fetch) are smoked manually; here we pin
the PURE logic that decides which files a skill is made of and the safety of
writing them: SKILL.md selection at arbitrary repo depth, script disclosure,
and the path-traversal guard that stops an untrusted archive escaping its dir.
"""

from __future__ import annotations

import os

import pytest

import backend.apps.skills.skills as skills_mod
from backend.apps.skill_registry.skill_registry import _select_skill_paths, _is_script_path


def test_selects_shortest_matching_skill_md_at_any_depth():
    tree = [
        {"type": "blob", "path": "README.md"},
        {"type": "blob", "path": "plugins/x/skills/pdftk/SKILL.md"},
        {"type": "blob", "path": "plugins/x/skills/pdftk/run.sh"},
        {"type": "blob", "path": "plugins/x/skills/pdftk/templates/form.txt"},
        {"type": "blob", "path": "plugins/x/skills/other/SKILL.md"},
    ]
    skill_md, members = _select_skill_paths(tree, "pdftk")
    assert skill_md == "plugins/x/skills/pdftk/SKILL.md"
    assert set(members) == {
        "plugins/x/skills/pdftk/SKILL.md",
        "plugins/x/skills/pdftk/run.sh",
        "plugins/x/skills/pdftk/templates/form.txt",
    }
    # The unrelated 'other' skill's files are excluded.
    assert all("/other/" not in m for m in members)


def test_top_level_skill_md():
    tree = [{"type": "blob", "path": "pdftk/SKILL.md"}, {"type": "blob", "path": "pdftk/x.py"}]
    skill_md, members = _select_skill_paths(tree, "pdftk")
    assert skill_md == "pdftk/SKILL.md"
    assert "pdftk/x.py" in members


def test_missing_skill_raises():
    with pytest.raises(ValueError):
        _select_skill_paths([{"type": "blob", "path": "a/SKILL.md"}], "nonexistent")


def test_script_classification():
    assert _is_script_path("run.sh")
    assert _is_script_path("helper.py")
    assert _is_script_path("scripts/build.txt")  # under a scripts/ dir
    assert _is_script_path("bin/tool")
    assert not _is_script_path("SKILL.md")
    assert not _is_script_path("templates/form.html")
    assert not _is_script_path("data.json")


# ---------------------------------------------------------------------------
# Safe install (write_folder_skill).
# ---------------------------------------------------------------------------

@pytest.fixture
def skills_dir(tmp_path, monkeypatch):
    d = tmp_path / "skills"
    d.mkdir()
    monkeypatch.setattr(skills_mod, "SKILLS_DIR", str(d))
    monkeypatch.setattr(skills_mod, "INDEX_PATH", str(d / ".skills_index.json"))
    return d


def test_write_folder_skill_lands_files_and_indexes(skills_dir):
    skill = skills_mod.write_folder_skill(
        "PDF Tk",
        {"SKILL.md": "---\nname: PDF Tk\n---\nbody", "scripts/run.sh": "echo hi"},
        {"name": "PDF Tk", "description": "fill forms"},
    )
    assert skill.id == "pdf-tk"
    assert skill.has_supporting_files is True
    assert os.path.isfile(skills_dir / "pdf-tk" / "SKILL.md")
    assert os.path.isfile(skills_dir / "pdf-tk" / "scripts" / "run.sh")
    # Re-syncs and shows up in the list.
    assert "pdf-tk" in {s.id for s in skills_mod._sync_skills()}


def test_install_dedups_instead_of_clobbering_existing_skill(skills_dir):
    # A user already has a local skill named "pdf".
    skills_mod.write_folder_skill("pdf", {"SKILL.md": "MINE"}, {"name": "My PDF"})
    # A wild-registry install of a same-named skill must NOT overwrite it.
    slug = skills_mod.unique_skill_slug("pdf")
    assert slug == "pdf-2"
    skills_mod.write_folder_skill(slug, {"SKILL.md": "THEIRS"}, {"name": "Registry PDF"})
    with open(skills_dir / "pdf" / "SKILL.md", encoding="utf-8") as f:
        assert f.read() == "MINE", "registry install clobbered the user's existing skill"
    with open(skills_dir / "pdf-2" / "SKILL.md", encoding="utf-8") as f:
        assert f.read() == "THEIRS"
    ids = {s.id for s in skills_mod._sync_skills()}
    assert {"pdf", "pdf-2"} <= ids


def test_write_folder_skill_blocks_path_traversal(skills_dir):
    skills_mod.write_folder_skill(
        "evil",
        {"SKILL.md": "x", "../escape.txt": "pwned", "/etc/abs.txt": "pwned"},
        {"name": "evil"},
    )
    # The escape attempts never landed outside the skill folder.
    assert not (skills_dir.parent / "escape.txt").exists()
    assert not os.path.exists("/etc/abs.txt") or open("/etc/abs.txt").read() != "pwned"
    # The legitimate SKILL.md did land.
    assert os.path.isfile(skills_dir / "evil" / "SKILL.md")
