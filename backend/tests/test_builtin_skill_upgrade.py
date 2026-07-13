"""Built-in skills must follow the bundled source across upgrades unless the user edited them.

Seeding used to be create-if-absent, which pinned every install to whatever shipped the day it
first booted: the App Builder agent's prompt kept a months-old skill and so never learned that
`.openswarm/terminal.log` existed. `seeded_hash` records the bytes we last wrote so an untouched
file can be safely replaced, while a real edit (or an untracked pre-existing install) is left alone.
"""

from __future__ import annotations

import json
import os

import pytest

import backend.apps.skills.skills as skills_mod


@pytest.fixture
def seeded(tmp_path, monkeypatch):
    """A stubbed SKILLS_DIR plus a one-entry built-in registry pointing at a bundle we control."""
    d = tmp_path / "skills"
    d.mkdir()
    monkeypatch.setattr(skills_mod, "SKILLS_DIR", str(d))
    monkeypatch.setattr(skills_mod, "INDEX_PATH", str(d / ".skills_index.json"))
    source = tmp_path / "bundled.md"
    source.write_text("v1 bundled", encoding="utf-8")

    def p_registry():
        return [{
            "id": "app_builder_skill",
            "name": "App Builder",
            "description": "d",
            "command": "app-builder-skill",
            "source_path": str(source),
        }]

    # String-literal setattr: p_built_in_skill_registry stays file-private under the p-private rule.
    monkeypatch.setattr(skills_mod, "p_built_in_skill_registry", p_registry)
    return d, source


def p_skill(d):
    return os.path.join(str(d), "app_builder_skill.md")


def p_read(d):
    return open(p_skill(d), encoding="utf-8").read()


def test_unedited_copy_upgrades_when_the_bundle_changes(seeded):
    d, source = seeded
    skills_mod.seed_built_in_skills()
    source.write_text("v2 bundled with terminal.log", encoding="utf-8")
    skills_mod.seed_built_in_skills()
    assert p_read(d) == "v2 bundled with terminal.log"


def test_user_edit_is_preserved_across_a_bundle_bump(seeded):
    d, source = seeded
    skills_mod.seed_built_in_skills()
    with open(p_skill(d), "w", encoding="utf-8") as f:
        f.write("my own house rules")
    source.write_text("v2 bundled", encoding="utf-8")
    skills_mod.seed_built_in_skills()
    assert p_read(d) == "my own house rules"


def test_second_boot_does_not_clobber_a_preserved_edit(seeded):
    # Regression: adopting the *current* bytes as provenance would make the next boot treat a real edit as unedited.
    d, source = seeded
    skills_mod.seed_built_in_skills()
    with open(p_skill(d), "w", encoding="utf-8") as f:
        f.write("my own house rules")
    source.write_text("v2 bundled", encoding="utf-8")
    skills_mod.seed_built_in_skills()
    skills_mod.seed_built_in_skills()
    assert p_read(d) == "my own house rules"


def test_untracked_stale_install_is_never_clobbered(seeded):
    # The real-world bug: a file seeded before seeded_hash existed. Indistinguishable from an edit, so leave it.
    d, source = seeded
    with open(p_skill(d), "w", encoding="utf-8") as f:
        f.write("stale bundle from an old install")
    source.write_text("v2 bundled", encoding="utf-8")
    skills_mod.seed_built_in_skills()
    assert p_read(d) == "stale bundle from an old install"
    with open(d / ".skills_index.json", encoding="utf-8") as f:
        assert "seeded_hash" not in json.load(f)["app_builder_skill"]
