"""The detail-page chrome's backend: the enable toggle must actually gate the agent-facing
surfaces (Skill tool load + sync list), and the file picker endpoint lists a folder skill's
text files with SKILL.md first."""

from __future__ import annotations

import pytest
from fastapi import HTTPException

import backend.apps.skills.skills as skills_mod
from backend.apps.skills.models import SkillUpdate


@pytest.fixture
def isolated_skills(tmp_path, monkeypatch):
    d = tmp_path / "skills"
    d.mkdir()
    monkeypatch.setattr(skills_mod, "SKILLS_DIR", str(d))
    monkeypatch.setattr(skills_mod, "INDEX_PATH", str(d / ".skills_index.json"))
    return d


def seed(name: str, extra: dict[str, str] | None = None) -> str:
    files = {"SKILL.md": f"---\nname: {name}\ndescription: d\n---\nbody"}
    files.update(extra or {})
    skill = skills_mod.write_folder_skill(skills_mod.safe_slug(name), files, {"name": name, "description": "d"})
    return skill.id


@pytest.mark.asyncio
async def test_disable_gates_load_and_listing(isolated_skills):
    sid = seed("Togglable")
    assert all(s.enabled for s in skills_mod.sync_skills())

    await skills_mod.update_skill(sid, SkillUpdate(enabled=False))
    target = next(s for s in skills_mod.sync_skills() if s.id == sid)
    assert target.enabled is False

    res = await skills_mod.load_skill(skills_mod.SkillLoadRequest(id=sid))
    assert res["ok"] is False
    assert res["error"] == "skill_disabled"
    assert sid not in res["available"]

    await skills_mod.update_skill(sid, SkillUpdate(enabled=True))
    res = await skills_mod.load_skill(skills_mod.SkillLoadRequest(id=sid))
    assert res["ok"] is True


@pytest.mark.asyncio
async def test_files_endpoint_lists_skill_md_first(isolated_skills):
    sid = seed("Multi", {"scripts/run.py": "print('hi')", "notes.txt": "n"})
    res = await skills_mod.list_skill_files(sid)
    paths = [f["path"] for f in res["files"]]
    assert paths[0] == "SKILL.md"
    assert "scripts/run.py" in paths
    assert "notes.txt" in paths


@pytest.mark.asyncio
async def test_files_endpoint_404_for_unknown(isolated_skills):
    with pytest.raises(HTTPException) as e:
        await skills_mod.list_skill_files("nope")
    assert e.value.status_code == 404
