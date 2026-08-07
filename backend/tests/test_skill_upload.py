"""The Directory's Upload skill endpoint: a bare SKILL .md needs YAML name+description,
a .zip/.skill archive needs a SKILL.md (shallowest wins, siblings ride along), and
anything else is refused with a readable reason."""

from __future__ import annotations

import base64
import io
import zipfile

import pytest
from fastapi import HTTPException

import backend.apps.skills.skills as skills_mod
from backend.apps.skills.models import SkillUpload


@pytest.fixture
def isolated_skills(tmp_path, monkeypatch):
    d = tmp_path / "skills"
    d.mkdir()
    monkeypatch.setattr(skills_mod, "SKILLS_DIR", str(d))
    monkeypatch.setattr(skills_mod, "INDEX_PATH", str(d / ".skills_index.json"))
    return d


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


def make_zip(entries: dict[str, str]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, content in entries.items():
            zf.writestr(name, content)
    return buf.getvalue()


@pytest.mark.asyncio
async def test_md_upload_creates_skill(isolated_skills):
    md = "---\nname: Test Upload\ndescription: A test\n---\n\n# Test Upload\n"
    res = await skills_mod.upload_skill(SkillUpload(filename="test.md", content_b64=b64(md.encode())))
    assert res["ok"] is True
    assert res["skill"]["name"] == "Test Upload"
    assert (isolated_skills / "test-upload" / "SKILL.md").is_file()


@pytest.mark.asyncio
async def test_md_without_frontmatter_rejected(isolated_skills):
    with pytest.raises(HTTPException) as e:
        await skills_mod.upload_skill(SkillUpload(filename="x.md", content_b64=b64(b"no yaml")))
    assert e.value.status_code == 400
    assert ".md file must contain skill name and description formatted in YAML" in e.value.detail


@pytest.mark.asyncio
async def test_zip_with_nested_skill_md(isolated_skills):
    raw = make_zip({
        "my-skill/SKILL.md": "---\nname: Zipped\ndescription: d\n---\nbody",
        "my-skill/scripts/run.py": "print('hi')",
        "unrelated/readme.txt": "not part of the skill",
    })
    res = await skills_mod.upload_skill(SkillUpload(filename="my-skill.zip", content_b64=b64(raw)))
    assert res["ok"] is True
    base = isolated_skills / "zipped"
    assert (base / "SKILL.md").is_file()
    assert (base / "scripts" / "run.py").is_file()
    assert not (base / "readme.txt").exists()


@pytest.mark.asyncio
async def test_zip_without_skill_md_rejected(isolated_skills):
    raw = make_zip({"folder/notes.md": "just notes"})
    with pytest.raises(HTTPException) as e:
        await skills_mod.upload_skill(SkillUpload(filename="x.zip", content_b64=b64(raw)))
    assert e.value.status_code == 400
    assert ".zip or .skill file must include a SKILL.md file" in e.value.detail


@pytest.mark.asyncio
async def test_unsupported_extension_rejected(isolated_skills):
    with pytest.raises(HTTPException) as e:
        await skills_mod.upload_skill(SkillUpload(filename="x.tar.gz", content_b64=b64(b"whatever")))
    assert e.value.status_code == 400


@pytest.mark.asyncio
async def test_bad_base64_rejected(isolated_skills):
    with pytest.raises(HTTPException) as e:
        await skills_mod.upload_skill(SkillUpload(filename="x.md", content_b64="!!!not-base64!!!"))
    assert e.value.status_code == 400
