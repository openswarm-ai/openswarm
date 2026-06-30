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
from backend.apps.skill_registry.skill_registry_github import select_skill_paths, is_script_path, tree_blob_paths


def test_selects_shortest_matching_skill_md_at_any_depth():
    tree = [
        {"type": "blob", "path": "README.md"},
        {"type": "blob", "path": "plugins/x/skills/pdftk/SKILL.md"},
        {"type": "blob", "path": "plugins/x/skills/pdftk/run.sh"},
        {"type": "blob", "path": "plugins/x/skills/pdftk/templates/form.txt"},
        {"type": "blob", "path": "plugins/x/skills/other/SKILL.md"},
    ]
    skill_md, members = select_skill_paths(tree, "pdftk")
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
    skill_md, members = select_skill_paths(tree, "pdftk")
    assert skill_md == "pdftk/SKILL.md"
    assert "pdftk/x.py" in members


def test_missing_skill_raises():
    with pytest.raises(ValueError):
        select_skill_paths([{"type": "blob", "path": "a/SKILL.md"}], "nonexistent")


def test_ambiguous_match_picks_deterministically():
    # Several <x>/pdf/SKILL.md: a top-level pdf/ wins, else skills/pdf/, never arbitrary.
    tree = [
        {"type": "blob", "path": "plugins/z/pdf/SKILL.md"},
        {"type": "blob", "path": "skills/pdf/SKILL.md"},
        {"type": "blob", "path": "pdf/SKILL.md"},
    ]
    skill_md, _ = select_skill_paths(tree, "pdf")
    assert skill_md == "pdf/SKILL.md"
    # Without a top-level one, prefer skills/<id>/.
    tree2 = [
        {"type": "blob", "path": "plugins/z/pdf/SKILL.md"},
        {"type": "blob", "path": "skills/pdf/SKILL.md"},
    ]
    skill_md2, _ = select_skill_paths(tree2, "pdf")
    assert skill_md2 == "skills/pdf/SKILL.md"


def test_github_headers_adds_token_when_set(monkeypatch):
    from backend.apps.skill_registry.skill_registry_github import github_headers
    monkeypatch.delenv("OPENSWARM_GITHUB_TOKEN", raising=False)
    monkeypatch.delenv("GITHUB_TOKEN", raising=False)
    assert "Authorization" not in github_headers()
    monkeypatch.setenv("OPENSWARM_GITHUB_TOKEN", "ghp_test")
    assert github_headers()["Authorization"] == "Bearer ghp_test"


def test_install_disclosure_flags_secret_shaped_files():
    # The scan we wire into the install disclosure (reused from the .swarm importer) must flag a community skill shipping credentials, and leave clean files alone.
    from backend.apps.swarm.redact import find_secrets_in_files
    files = {
        "SKILL.md": b"Renders PDFs. No secrets.",
        "config.py": b'API_KEY = "sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH"',
    }
    hits = find_secrets_in_files(files)
    assert "config.py" in hits
    assert "SKILL.md" not in hits


def test_script_classification():
    assert is_script_path("run.sh")
    assert is_script_path("helper.py")
    assert is_script_path("scripts/build.txt")  # under a scripts/ dir
    assert is_script_path("bin/tool")
    assert not is_script_path("SKILL.md")
    assert not is_script_path("templates/form.html")
    assert not is_script_path("data.json")


# --------------------------------------------------------------------------- Safe install (write_folder_skill). ---------------------------------------------------------------------------

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
    assert "pdf-tk" in {s.id for s in skills_mod.sync_skills()}


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
    ids = {s.id for s in skills_mod.sync_skills()}
    assert {"pdf", "pdf-2"} <= ids


def test_confirm_install_writes_folder_lists_and_injects(skills_dir, monkeypatch):
    """End-to-end install->usable: confirm=true through the real /install endpoint
    writes the folder skill, it shows up in /api/skills/list with supporting
    files, and resolve_attached_skills injects it with the folder path so an
    agent can read its scripts. (resolve is mocked to skip the network; the live
    GitHub resolve is proven separately.)"""
    import secrets as p_secrets
    from fastapi.testclient import TestClient
    from backend.main import app
    from backend.apps.agents.manager.prompt.prompt_context import resolve_attached_skills
    import backend.auth as auth_mod
    if not auth_mod.TOKEN:
        auth_mod.TOKEN = p_secrets.token_urlsafe(32)
    client = TestClient(app, headers={"Authorization": f"Bearer {auth_mod.TOKEN}"})

    async def fake_resolve(source, skill_id):
        return {
            "name": "PDF Tools", "description": "work with pdfs", "repo_url": "https://github.com/o/r",
            "skill_id": skill_id,
            "files": {"SKILL.md": "# PDF Tools\nRun scripts/extract.py to pull text.",
                      "scripts/extract.py": "print('extract')"},
            "scripts": ["scripts/extract.py"], "secret_findings": [],
        }
    monkeypatch.setattr("backend.apps.skill_registry.skill_registry_sources.resolve_community_skill", fake_resolve)

    r = client.post("/api/skill-registry/install", json={"source": "o/r", "skill_id": "pdf-tools", "confirm": True})
    assert r.status_code == 200 and r.json()["installed"] is True
    slug = r.json()["skill"]["id"]

    # Listed via the real skills API, flagged as multi-file.
    listed = {s["id"]: s for s in client.get("/api/skills/list").json()["skills"]}
    assert slug in listed and listed[slug]["has_supporting_files"] is True
    # On disk as a folder with the script.
    assert (skills_dir / slug / "SKILL.md").exists()
    assert (skills_dir / slug / "scripts" / "extract.py").exists()
    # Injectable: the agent gets the body AND a pointer to the folder for on-demand reads.
    block = resolve_attached_skills([{"id": slug, "name": "PDF Tools", "content": "# PDF Tools\nRun scripts/extract.py to pull text."}])
    assert "[Using skill: PDF Tools]" in block
    assert str(skills_dir / slug) in block


class FakeResp:
    def __init__(self, status, payload=None, text=""):
        self.status_code = status
        self.p_payload = payload
        self.text = text

    def json(self):
        return self.p_payload


CURATED_TREE = {"tree": [
    {"type": "tree", "path": "skills/pdf", "sha": "PDFSHA1"},
    {"type": "blob", "path": "skills/pdf/SKILL.md"},
    {"type": "blob", "path": "skills/pdf/scripts/extract.py"},
    {"type": "tree", "path": "skills/pdf/scripts", "sha": "SCRIPTSHA"},
    {"type": "blob", "path": "skills/pdf/reference/notes.md"},
    {"type": "blob", "path": "skills/pdf-extra/SKILL.md"},
    {"type": "blob", "path": "skills/other/SKILL.md"},
]}


def test_curated_resolve_fetches_exact_folder_only(monkeypatch):
    """Curated install must pull the WHOLE skill folder (so scripts/assets land),
    matched by EXACT path: a sibling folder sharing a name prefix (skills/pdf vs
    skills/pdf-extra) must not leak in. Here the cache is COLD, so it pays one live
    tree call."""
    import asyncio
    import backend.apps.skill_registry.skill_registry_sources as sr
    monkeypatch.setattr(sr, "curated_tree",[])

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, url):
            if "git/trees" in url:
                return FakeResp(200, payload=CURATED_TREE)
            rel = url.split("/main/", 1)[1]
            return FakeResp(200, text=f"content:{rel}") if rel.startswith("skills/pdf/") else FakeResp(404)

    monkeypatch.setattr(sr.httpx, "AsyncClient", lambda *a, **k: FakeClient())

    resolved = asyncio.run(sr.resolve_curated_skill("skills/pdf"))
    assert set(resolved["files"].keys()) == {"SKILL.md", "scripts/extract.py", "reference/notes.md"}
    assert resolved["scripts"] == ["scripts/extract.py"]
    assert resolved["skill_id"] == "pdf"


def test_curated_resolve_uses_warm_cache_with_zero_api_calls(monkeypatch):
    """B1: when the tree cache is warm, a curated install makes ZERO trees-API calls,
    it reads paths from the cache and pulls contents over raw only. It also records
    provenance (source/folder/version) for later update detection."""
    import asyncio
    import backend.apps.skill_registry.skill_registry_sources as sr
    monkeypatch.setattr(sr, "curated_tree",CURATED_TREE["tree"])

    class NoApiClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, url):
            if "git/trees" in url or "api.github.com" in url:
                raise AssertionError(f"warm cache must not hit the API: {url}")
            rel = url.split("/main/", 1)[1]
            return FakeResp(200, text=f"content:{rel}") if rel.startswith("skills/pdf/") else FakeResp(404)

    monkeypatch.setattr(sr.httpx, "AsyncClient", lambda *a, **k: NoApiClient())

    resolved = asyncio.run(sr.resolve_curated_skill("skills/pdf"))
    assert set(resolved["files"].keys()) == {"SKILL.md", "scripts/extract.py", "reference/notes.md"}
    assert resolved["source"] == "anthropics/skills"
    assert resolved["folder"] == "skills/pdf"
    assert resolved["version"] == "PDFSHA1"


def test_warm_curated_tree_populates_cache(monkeypatch):
    """The hourly warm-up caches the repo's full tree so later installs skip the API."""
    import asyncio
    import backend.apps.skill_registry.skill_registry_sources as sr
    monkeypatch.setattr(sr, "curated_tree",[])

    class TreeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, url):
            assert "git/trees" in url
            return FakeResp(200, payload=CURATED_TREE)

    monkeypatch.setattr(sr.httpx, "AsyncClient", lambda *a, **k: TreeClient())
    asyncio.run(sr.warm_curated_tree())
    assert "skills/pdf/SKILL.md" in tree_blob_paths(sr.curated_tree)


def test_skill_update_detection_and_apply(skills_dir, monkeypatch):
    """End-to-end versioning: a curated skill recorded at an OLD folder SHA reads as
    outdated against the warmed tree; applying the update re-fetches, bumps the version,
    and it stops being outdated."""
    import secrets as p_secrets
    from fastapi.testclient import TestClient
    from backend.main import app
    import backend.auth as auth_mod
    import backend.apps.skill_registry.skill_registry_sources as sr
    import backend.apps.skills.skills as skills_mod
    if not auth_mod.TOKEN:
        auth_mod.TOKEN = p_secrets.token_urlsafe(32)
    client = TestClient(app, headers={"Authorization": f"Bearer {auth_mod.TOKEN}"})

    # Upstream folder SHA for skills/pdf is PDFSHA1 (from the warmed tree).
    monkeypatch.setattr(sr, "curated_tree",CURATED_TREE["tree"])
    # Installed copy recorded at a STALE version, so it should read as outdated.
    skills_mod.write_folder_skill("pdf", {"SKILL.md": "old"}, {
        "name": "PDF", "source": "anthropics/skills", "folder": "skills/pdf", "version": "OLDSHA",
    })

    r = client.get("/api/skill-registry/updates")
    assert r.status_code == 200 and "pdf" in r.json()["outdated"]

    async def fake_resolve(folder):
        return {"name": "PDF", "description": "pdfs", "skill_id": "pdf",
                "files": {"SKILL.md": "new", "scripts/x.py": "print(1)"},
                "scripts": ["scripts/x.py"], "secret_findings": [],
                "source": "anthropics/skills", "folder": "skills/pdf", "version": "PDFSHA1"}
    monkeypatch.setattr(sr, "resolve_curated_skill", fake_resolve)

    u = client.post("/api/skill-registry/update", json={"skill_id": "pdf"})
    assert u.status_code == 200 and u.json()["updated"] is True
    assert (skills_dir / "pdf" / "scripts" / "x.py").exists()

    r2 = client.get("/api/skill-registry/updates")
    assert "pdf" not in r2.json()["outdated"] and "pdf" in r2.json()["checked"]


def test_curated_install_writes_full_folder(skills_dir, monkeypatch):
    """End-to-end: /install-curated writes the full folder (SKILL.md + scripts), and
    the skill shows up in /api/skills/list flagged multi-file. (resolve mocked to
    skip the network; the exact-folder fetch is proven separately.)"""
    import secrets as p_secrets
    from fastapi.testclient import TestClient
    from backend.main import app
    import backend.auth as auth_mod
    if not auth_mod.TOKEN:
        auth_mod.TOKEN = p_secrets.token_urlsafe(32)
    client = TestClient(app, headers={"Authorization": f"Bearer {auth_mod.TOKEN}"})

    async def fake_resolve(folder):
        return {
            "name": "PDF", "description": "work with pdfs",
            "repo_url": "https://github.com/anthropics/skills/tree/main/skills/pdf",
            "skill_id": "pdf",
            "files": {"SKILL.md": "# PDF\nRun scripts/extract.py", "scripts/extract.py": "print('x')"},
            "scripts": ["scripts/extract.py"], "secret_findings": [],
        }
    monkeypatch.setattr("backend.apps.skill_registry.skill_registry_sources.resolve_curated_skill", fake_resolve)

    r = client.post("/api/skill-registry/install-curated", json={"folder": "skills/pdf"})
    assert r.status_code == 200 and r.json()["installed"] is True
    slug = r.json()["skill"]["id"]
    assert (skills_dir / slug / "SKILL.md").exists()
    assert (skills_dir / slug / "scripts" / "extract.py").exists()
    listed = {s["id"]: s for s in client.get("/api/skills/list").json()["skills"]}
    assert slug in listed and listed[slug]["has_supporting_files"] is True


def test_manual_rm_leaves_no_ghost_blocking_slug(skills_dir):
    """A folder deleted out-of-band (manual rm) must not keep squatting its slug via
    a leftover index entry: existence is by files on disk, and a prune cleans the index."""
    import shutil
    skills_mod.write_folder_skill("pdf", {"SKILL.md": "x"}, {"name": "PDF"})
    shutil.rmtree(skills_dir / "pdf")  # delete the folder, leave the index entry
    # The ghost index entry must NOT count as existing, so the clean slug is reclaimable.
    assert skills_mod.p_skill_exists("pdf") is False
    assert skills_mod.unique_skill_slug("pdf") == "pdf"
    # And the prune drops the dead entry.
    assert "pdf" in skills_mod.load_index()
    skills_mod.p_prune_orphan_index()
    assert "pdf" not in skills_mod.load_index()


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
