"""Multi-file (folder) skills, plus backward compatibility with legacy flat skills.

A skill is now either ~/.claude/skills/<id>/SKILL.md (with optional supporting
files) or a legacy ~/.claude/skills/<id>.md. Both must list, read, and delete
correctly, and a folder skill with supporting files must get its folder path
appended to the prompt so the agent can read those files on demand.
"""

from __future__ import annotations

import os
import json

import pytest

import backend.apps.skills.skills as skills_mod
from backend.apps.agents.manager.prompt.prompt_context import resolve_attached_skills


@pytest.fixture
def skills_dir(tmp_path, monkeypatch):
    d = tmp_path / "skills"
    d.mkdir()
    monkeypatch.setattr(skills_mod, "SKILLS_DIR", str(d))
    monkeypatch.setattr(skills_mod, "INDEX_PATH", str(d / ".skills_index.json"))
    return d


def p_write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


def test_corrupt_index_does_not_brick_skills_and_is_preserved(skills_dir):
    p_write(str(skills_dir / "alpha.md"), "content")
    with open(skills_dir / ".skills_index.json", "w") as f:
        f.write("{ not valid json")
    # Load returns empty instead of raising, and moves the bad file aside.
    assert skills_mod.load_index() == {}
    assert (skills_dir / ".skills_index.json.corrupt").exists()
    # Skills still list (name falls back to the filename), so nothing is bricked.
    assert "alpha" in {s.id for s in skills_mod.sync_skills()}


def test_non_object_index_is_rejected(skills_dir):
    with open(skills_dir / ".skills_index.json", "w") as f:
        f.write("[1, 2, 3]")
    assert skills_mod.load_index() == {}


def test_save_index_is_atomic_no_temp_leftover(skills_dir):
    skills_mod.save_index({"x": {"name": "X"}})
    assert skills_mod.load_index() == {"x": {"name": "X"}}
    leftovers = [n for n in __import__("os").listdir(skills_dir) if n.startswith(".skills_index.") and n.endswith(".tmp")]
    assert leftovers == []


def test_flat_skill_still_syncs(skills_dir):
    p_write(str(skills_dir / "my-flat.md"), "do the flat thing")
    skills = {s.id: s for s in skills_mod.sync_skills()}
    assert "my-flat" in skills
    s = skills["my-flat"]
    assert s.content == "do the flat thing"
    assert s.dir_path == ""
    assert s.has_supporting_files is False


def test_folder_skill_syncs_with_supporting_files(skills_dir):
    base = skills_dir / "remotion"
    p_write(str(base / "SKILL.md"), "---\nname: Remotion\ndescription: make videos\n---\nrender stuff")
    p_write(str(base / "helper.py"), "print('hi')")
    skills = {s.id: s for s in skills_mod.sync_skills()}
    assert "remotion" in skills
    s = skills["remotion"]
    assert "render stuff" in s.content
    assert s.dir_path == str(base)
    assert s.has_supporting_files is True
    # Frontmatter fills name/description when the index hasn't catalogued it.
    assert s.name == "Remotion"
    assert s.description == "make videos"


def test_folder_skill_without_extra_files_flags_false(skills_dir):
    base = skills_dir / "solo"
    p_write(str(base / "SKILL.md"), "just one file")
    s = {x.id: x for x in skills_mod.sync_skills()}["solo"]
    assert s.dir_path == str(base)
    assert s.has_supporting_files is False


@pytest.mark.asyncio
async def test_delete_removes_folder(skills_dir):
    base = skills_dir / "doomed"
    p_write(str(base / "SKILL.md"), "x")
    p_write(str(base / "data.txt"), "y")
    assert base.is_dir()
    await skills_mod.delete_skill("doomed")
    assert not base.exists()


@pytest.mark.asyncio
async def test_update_writes_folder_skill_md(skills_dir):
    base = skills_dir / "editable"
    p_write(str(base / "SKILL.md"), "old body")
    from backend.apps.skills.models import SkillUpdate
    res = await skills_mod.update_skill("editable", SkillUpdate(content="new body", description="d"))
    assert res["ok"]
    with open(base / "SKILL.md", encoding="utf-8") as f:
        assert f.read() == "new body"
    assert res["skill"]["dir_path"] == str(base)


def test_injection_points_at_folder_for_supporting_files(skills_dir):
    base = skills_dir / "withfiles"
    p_write(str(base / "SKILL.md"), "use the template")
    p_write(str(base / "template.html"), "<html></html>")

    block = resolve_attached_skills([{"id": "withfiles", "name": "WithFiles", "content": "use the template"}])
    assert "[Using skill: WithFiles]" in block
    assert str(base) in block
    assert "Read" in block  # tells the agent to read supporting files


def test_skill_injection_is_provider_agnostic_by_construction(skills_dir):
    """The provider-agnostic claim, proven structurally (a live GPT/Gemini run
    needs a key): the injector takes no provider arg so it CAN'T differ by model,
    it points at supporting files via the universal Read tool, and Read is in the
    builtin set every provider gets. So a non-Claude agent receives byte-identical
    skill text and the same file-reading tools."""
    import inspect
    from backend.apps.agents.manager.prompt.prompt_context import resolve_attached_skills
    from backend.apps.agents.manager.prompt.tool_catalog import FULL_TOOLS

    # 1. No provider/api parameter -> the injected text cannot branch on the model.
    assert set(inspect.signature(resolve_attached_skills).parameters) == {"attached_skills"}

    # 2. A folder skill yields the body + a pointer to its folder via Read/Glob/Bash.
    base = skills_dir / "vid"
    p_write(str(base / "SKILL.md"), "render it")
    p_write(str(base / "helper.py"), "x")
    block = resolve_attached_skills([{"id": "vid", "name": "Vid", "content": "render it"}])
    assert "[Using skill: Vid]" in block
    assert str(base) in block and "Read" in block

    # 3. Those file tools are universal builtins, not an Anthropic-only set.
    assert {"Read", "Glob", "Bash"} <= set(FULL_TOOLS)


def test_injection_no_folder_note_for_flat_skill(skills_dir):
    p_write(str(skills_dir / "plain.md"), "plain content")
    block = resolve_attached_skills([{"id": "plain", "name": "Plain", "content": "plain content"}])
    assert "[Using skill: Plain]" in block
    assert "supporting files" not in block.lower()


# --------------------------------------------------------------------------- .swarm round-trip for folder skills (export carries files, import rebuilds them). ---------------------------------------------------------------------------

def test_swarm_export_folder_skill_carries_supporting_files(skills_dir):
    from backend.apps.swarm.entities.skills import SkillExportable
    base = skills_dir / "vid"
    p_write(str(base / "SKILL.md"), "render")
    p_write(str(base / "scripts" / "go.py"), "print(1)")
    exp = SkillExportable.load("vid")
    assert exp is not None
    files = exp.files()
    assert "scripts/go.py" in files
    assert files["scripts/go.py"] == b"print(1)"
    assert exp.payload["content"] == "render"


def test_swarm_import_writes_folder_when_files_present(skills_dir):
    from backend.apps.swarm.entities.skills import SkillExportable
    payload = {"slug": "vid", "name": "Vid", "description": "d", "command": "vid", "content": "render"}
    new_id = SkillExportable.import_(payload, {"scripts/go.py": b"print(1)"}, None)
    assert os.path.isfile(skills_dir / new_id / "SKILL.md")
    assert os.path.isfile(skills_dir / new_id / "scripts" / "go.py")
    synced = {s.id: s for s in skills_mod.sync_skills()}
    assert synced[new_id].has_supporting_files is True


def test_swarm_import_always_writes_folder(skills_dir):
    # Unified storage: even a one-file skill imports as a folder, so a skill's on-disk shape never depends on whether it had supporting files.
    from backend.apps.swarm.entities.skills import SkillExportable
    payload = {"slug": "note", "name": "Note", "content": "just text"}
    new_id = SkillExportable.import_(payload, {}, None)
    assert os.path.isfile(skills_dir / new_id / "SKILL.md")
    assert not (skills_dir / f"{new_id}.md").exists()


@pytest.mark.asyncio
async def test_create_writes_folder_and_supersedes_legacy_flat(skills_dir):
    from backend.apps.skills.models import SkillCreate
    # A pre-existing legacy flat skill of the same id...
    p_write(str(skills_dir / "notes.md"), "old flat")
    # ...is superseded (not shadowed) when the user (re)creates it; folder wins, and the phantom flat file is removed so there's exactly one shape on disk.
    res = await skills_mod.create_skill(SkillCreate(name="Notes", content="new body", description="d"))
    sid = res["skill"]["id"]
    assert sid == "notes"
    assert os.path.isfile(skills_dir / "notes" / "SKILL.md")
    assert not (skills_dir / "notes.md").exists()
    only = [s for s in skills_mod.sync_skills() if s.id == "notes"]
    assert len(only) == 1 and only[0].content == "new body"


def test_stage_zip_carries_supporting_files_into_sandbox():
    import io as p_io, zipfile, os as p_os, shutil
    from backend.apps.swarm.closure import stage_skill_from_zip
    buf = p_io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("my-skill/SKILL.md", "do it")
        zf.writestr("my-skill/scripts/run.sh", "echo hi")
    sandbox, manifest, warnings = stage_skill_from_zip(buf.getvalue(), "my-skill.zip", [])
    try:
        bid = manifest.entities[0].bundle_id
        files_dir = p_os.path.join(sandbox, "entities", bid, "files")
        assert p_os.path.isfile(p_os.path.join(files_dir, "scripts", "run.sh"))
        # SKILL.md is the payload body, not a supporting file.
        assert not p_os.path.exists(p_os.path.join(files_dir, "SKILL.md"))
    finally:
        shutil.rmtree(sandbox, ignore_errors=True)
