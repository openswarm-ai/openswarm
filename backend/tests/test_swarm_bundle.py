"""Tests for the .swarm bundle engine: skill round-trip, secret redaction, and
the zip-hardening rejections. The skills store writes to ~/.claude/skills, so we
monkeypatch it into a temp dir per test (the conftest only isolates browser
state)."""
import io
import json
import os
import zipfile

import pytest

from backend.apps.skills import skills as store
from backend.apps.swarm import closure
from backend.apps.swarm.models import EntityType
from backend.apps.swarm.redact import find_denied_keys, scrub_payload
from backend.apps.swarm.ziputil import BundleError, pack, unpack


@pytest.fixture
def skill_store(tmp_path, monkeypatch):
    d = tmp_path / "skills"
    d.mkdir()
    monkeypatch.setattr(store, "SKILLS_DIR", str(d))
    monkeypatch.setattr(store, "INDEX_PATH", str(d / ".skills_index.json"))
    return d


def _make_skill(d, slug, name, content, description="desc"):
    (d / f"{slug}.md").write_text(content, encoding="utf-8")
    index = store._load_index()
    index[slug] = {"name": name, "description": description, "command": slug}
    store._save_index(index)


def test_skill_export_import_round_trip(skill_store):
    _make_skill(skill_store, "my-skill", "My Skill", "# hello\nbody text")
    raw, name = closure.build_bundle(EntityType.skill, "my-skill")
    assert name == "My Skill"
    assert zipfile.is_zipfile(io.BytesIO(raw))

    sandbox, manifest, warnings = closure.stage_upload(raw, "My Skill.swarm")
    try:
        assert manifest.root.type == EntityType.skill
        root_type, root_id, created, unresolved = closure.commit(sandbox, manifest, [])
    finally:
        import shutil
        shutil.rmtree(sandbox, ignore_errors=True)

    # Original is untouched, import lands under a fresh, non-clobbering slug.
    assert root_type == EntityType.skill
    assert root_id != "my-skill"
    assert (skill_store / "my-skill.md").exists()
    assert (skill_store / f"{root_id}.md").read_text(encoding="utf-8") == "# hello\nbody text"
    assert created == {"skill": [root_id]}


def test_bare_markdown_import(skill_store):
    sandbox, manifest, warnings = closure.stage_upload(b"# Just markdown", "Cool Trick.md")
    try:
        assert manifest.root.type == EntityType.skill
        assert manifest.root.name == "Cool Trick"
        _t, root_id, created, _u = closure.commit(sandbox, manifest, [])
    finally:
        import shutil
        shutil.rmtree(sandbox, ignore_errors=True)
    assert (skill_store / f"{root_id}.md").read_text(encoding="utf-8") == "# Just markdown"


def test_content_secret_redacted_in_bundle(skill_store):
    secret = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA"
    _make_skill(skill_store, "leaky", "Leaky", f"use this key: {secret}")
    raw, _name = closure.build_bundle(EntityType.skill, "leaky")
    # Inspect the actual packed payload (zip entries are compressed, so grepping
    # the raw bytes proves nothing).
    with zipfile.ZipFile(io.BytesIO(raw)) as zf:
        payload_name = next(n for n in zf.namelist() if n.endswith("payload.json"))
        payload = json.loads(zf.read(payload_name))
    assert secret not in payload["content"]
    assert "[redacted]" in payload["content"]


def test_redaction_drops_denied_keys():
    payload = {
        "name": "ok",
        "anthropic_api_key": "sk-ant-secret",
        "nested": {"openswarm_bearer_token": "abc", "keep": 1},
        "list": [{"oauth_tokens": {"x": 1}}, {"fine": 2}],
    }
    cleaned = scrub_payload(payload)
    assert find_denied_keys(cleaned) == []
    assert cleaned["name"] == "ok"
    assert cleaned["nested"]["keep"] == 1
    assert cleaned["list"][1]["fine"] == 2


def test_pack_refuses_denied_key():
    # Defense in depth: even if redaction were skipped, pack must not ship a secret.
    with pytest.raises(BundleError):
        pack({"format_version": 1}, {"bid1": {"api_key": "leak"}}, {})


def test_pack_refuses_secret_in_workspace_file():
    # A key hardcoded in app source (not .env) must not ride along; pack scans
    # file bytes, not just payload keys.
    leak = b"const KEY = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA';\n"
    with pytest.raises(BundleError):
        pack({"format_version": 1}, {"bid1": {"name": "ok"}}, {"entities/bid1/files/config.js": leak})


def test_pack_allows_clean_workspace_file():
    raw = pack({"format_version": 1}, {"bid1": {"name": "ok"}}, {"entities/bid1/files/app.js": b"export default 1"})
    assert zipfile.is_zipfile(io.BytesIO(raw))


def test_app_export_drops_machine_env(tmp_path, monkeypatch):
    # The live .env holds the source machine's absolute paths + pinned port; it
    # must never ride along. .env.example (portable) does.
    from backend.apps.swarm.entities import apps as appmod
    from backend.apps.outputs.models import Output

    ws = tmp_path / "ws"
    (ws / "frontend").mkdir(parents=True)
    (ws / ".env").write_text("FRONTEND_PORT=5\nOPENSWARM_TEMPLATE_BACKEND_PATH=/Users/SECRET/x\n")
    (ws / ".env.example").write_text("BACKEND_PORT=NONE\nFRONTEND_PORT=4949\n")
    (ws / "frontend" / "App.tsx").write_text("export default () => null")
    monkeypatch.setattr(appmod, "OUTPUTS_WORKSPACE_DIR", str(tmp_path))

    ex = appmod.AppExportable(Output(name="A", workspace_id="ws"))
    files = ex.files()
    assert "workspace/.env.example" in files
    assert "workspace/.env" not in files
    assert "workspace/frontend/App.tsx" in files
    assert b"/Users/SECRET" not in b"".join(files.values())


def test_workflow_sanitize_disables_schedule_and_strips_pii():
    from backend.apps.swarm.entities.workflows import _sanitize_workflow
    raw = {
        "id": "wf123",
        "title": "Daily digest",
        "steps": [{"id": "s1", "text": "do thing"}],
        "schedule": {"enabled": True, "runs_count": 5, "next_run_at": "2026-01-01T00:00:00", "hour": 9},
        "permissions": [{"kind": "text", "after_minutes": 30, "phone": "+15551234567"}],
        "source_session_id": "sess1",
        "dashboard_id": "dash1",
        "last_run_status": "success",
        "mode": "agent",
        "provider": "anthropic",
    }
    out = _sanitize_workflow(raw)
    # An imported workflow must not auto-run or carry the sharer's identity.
    assert out["schedule"]["enabled"] is False
    assert out["schedule"]["runs_count"] == 0
    assert out["schedule"]["hour"] == 9  # cadence shape preserved
    assert out["permissions"][0]["phone"] is None
    for dropped in ("id", "source_session_id", "dashboard_id", "last_run_status"):
        assert dropped not in out
    assert out["title"] == "Daily digest"


def test_workflow_unavailable_on_this_branch():
    # The workflow store isn't on eric/dev, so load() degrades gracefully and
    # importing a workflow bundle fails with a clear message (no half-write).
    from backend.apps.swarm.entities.workflows import WorkflowExportable
    from backend.apps.swarm.exportable import RemapTable
    assert WorkflowExportable.load("anything") is None
    with pytest.raises(BundleError):
        WorkflowExportable.import_({"title": "x"}, {}, RemapTable())


def test_session_export_strips_transcript_and_secrets():
    from backend.apps.swarm.entities.sessions import SessionExportable
    data = {
        "name": "A", "provider": "anthropic", "model": "sonnet", "mode": "agent",
        "system_prompt": "hi", "allowed_tools": ["Read"],
        "messages": [{"role": "user", "content": "private chat"}],
        "active_mcps": ["Gmail"], "cwd": "/Users/me/repo", "cost_usd": 9.9, "sdk_session_id": "x",
    }
    ex = SessionExportable("s1", "A", data)
    out = ex.serialize(None)
    for gone in ("messages", "cwd", "active_mcps", "cost_usd", "sdk_session_id"):
        assert gone not in out
    assert out["model"] == "sonnet" and out["mode"] == "agent"
    reqs = ex.requirements()
    assert any(r.kind.value == "mcp_action" and r.key == "Gmail" for r in reqs)


def test_dashboard_serialize_rewrites_refs_to_bundle_ids():
    from backend.apps.swarm.entities.dashboards import DashboardExportable
    from backend.apps.swarm.models import EntityType

    class Ctx:
        def bundle_id_for(self, t: EntityType, lid: str):
            return {("session", "S"): "SBID", ("app", "A"): "ABID"}.get((t.value, lid))

    data = {"name": "D", "layout": {
        "cards": {"S": {"session_id": "S", "x": 1}},
        "view_cards": {"A": {"output_id": "A", "x": 2}},
        "browser_cards": {"b1": {"browser_id": "b1", "url": "u", "spawned_by": "S"}},
        "expanded_session_ids": ["S"],
    }}
    L = DashboardExportable("d1", "D", data).serialize(Ctx())["layout"]
    assert L["cards"]["SBID"]["session_id"] == "SBID"
    assert L["view_cards"]["ABID"]["output_id"] == "ABID"
    assert L["browser_cards"]["b1"]["spawned_by"] == "SBID"
    assert L["expanded_session_ids"] == ["SBID"]


def test_dashboard_import_remaps_to_fresh_local_ids(monkeypatch):
    from backend.apps.swarm.entities import dashboards as dmod
    from backend.apps.swarm.exportable import RemapTable

    written: dict = {}
    monkeypatch.setattr(dmod, "_write", lambda did, doc: written.update({did: doc}))
    monkeypatch.setattr(dmod, "_retag_sessions", lambda ids, did: None)
    remap = RemapTable()
    remap.assign("SBID", "newsess")
    remap.assign("ABID", "newapp")
    payload = {"name": "D", "layout": {
        "cards": {"SBID": {"session_id": "SBID"}},
        "view_cards": {"ABID": {"output_id": "ABID"}},
        "browser_cards": {"b1": {"browser_id": "b1", "spawned_by": "SBID"}},
        "expanded_session_ids": ["SBID", "ORPHAN"],
    }}
    did = dmod.DashboardExportable.import_(payload, {}, remap)
    L = written[did]["layout"]
    assert L["cards"]["newsess"]["session_id"] == "newsess"
    assert "newapp" in L["view_cards"]
    assert list(L["browser_cards"].values())[0]["spawned_by"] == "newsess"
    assert L["expanded_session_ids"] == ["newsess"]  # the dangling ref is dropped


def test_checksum_rejects_tampering(skill_store):
    _make_skill(skill_store, "tmp", "Tmp", "# original")
    raw, _ = closure.build_bundle(EntityType.skill, "tmp")
    # Rebuild the zip with the same manifest (old checksum) but an edited payload.
    src = zipfile.ZipFile(io.BytesIO(raw))
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as out:
        for n in src.namelist():
            data = src.read(n)
            if n.endswith("payload.json"):
                d = json.loads(data)
                d["content"] = "TAMPERED"
                data = json.dumps(d, indent=2).encode("utf-8")
            out.writestr(n, data)
    with pytest.raises(BundleError):
        closure.stage_upload(buf.getvalue(), "tmp.swarm")


def test_skill_rollback_removes_it(skill_store):
    from backend.apps.swarm.entities.skills import SkillExportable
    from backend.apps.swarm.exportable import RemapTable
    sid = SkillExportable.import_({"slug": "rbk", "name": "Rbk", "content": "x"}, {}, RemapTable())
    assert (skill_store / f"{sid}.md").exists()
    SkillExportable.rollback(sid)
    assert not (skill_store / f"{sid}.md").exists()
    assert sid not in store._load_index()


def test_commit_rolls_back_created_on_failure(skill_store, tmp_path):
    # A bundle of [skill, workflow]: skill imports first, then the workflow import
    # fails (no workflow store on this branch), so the skill must be rolled back.
    from backend.apps.swarm.models import BundlePreview, EntityRef, Manifest

    sb = tmp_path / "sb"
    skill_ref = EntityRef(type=EntityType.skill, bundle_id="s1", name="S", path="entities/s1")
    wf_ref = EntityRef(type=EntityType.workflow, bundle_id="w1", name="W", path="entities/w1")
    for ref, payload in ((skill_ref, {"slug": "rollme", "name": "Rollme", "content": "hi"}), (wf_ref, {"title": "W"})):
        d = sb / "entities" / ref.bundle_id
        d.mkdir(parents=True)
        (d / "payload.json").write_text(json.dumps(payload), encoding="utf-8")
    manifest = Manifest(
        bundle_id="b", root=skill_ref, entities=[skill_ref, wf_ref],
        preview=BundlePreview(root_type=EntityType.skill, root_name="S"),
    )
    with pytest.raises(BundleError):
        closure.commit(str(sb), manifest, [])
    assert "rollme" not in store._load_index()
    assert not (skill_store / "rollme.md").exists()


def test_manifest_duplicate_ids_rejected():
    # Two entities sharing a bundle_id silently collapse in the topo/summary
    # dicts, dropping one; reject up front. (The manifest is outside the checksum.)
    from backend.apps.swarm.closure import validate_manifest
    from backend.apps.swarm.models import BundlePreview, EntityRef, Manifest
    ref = EntityRef(type=EntityType.skill, bundle_id="dup", name="A", path="entities/dup")
    m = Manifest(bundle_id="b", root=ref, entities=[ref, ref],
                 preview=BundlePreview(root_type=EntityType.skill, root_name="A"))
    with pytest.raises(BundleError):
        validate_manifest(m)


def test_manifest_root_not_in_entities_rejected():
    from backend.apps.swarm.closure import validate_manifest
    from backend.apps.swarm.models import BundlePreview, EntityRef, Manifest
    root = EntityRef(type=EntityType.skill, bundle_id="root", name="A", path="entities/root")
    other = EntityRef(type=EntityType.skill, bundle_id="other", name="B", path="entities/other")
    m = Manifest(bundle_id="b", root=root, entities=[other],
                 preview=BundlePreview(root_type=EntityType.skill, root_name="A"))
    with pytest.raises(BundleError):
        validate_manifest(m)


def test_manifest_edge_to_unknown_entity_rejected():
    from backend.apps.swarm.closure import validate_manifest
    from backend.apps.swarm.models import BundlePreview, DependencyEdge, EntityRef, Manifest
    ref = EntityRef(type=EntityType.dashboard, bundle_id="d", name="D", path="entities/d")
    m = Manifest(bundle_id="b", root=ref, entities=[ref],
                 edges=[DependencyEdge(**{"from": "d", "to": "ghost"})],
                 preview=BundlePreview(root_type=EntityType.dashboard, root_name="D"))
    with pytest.raises(BundleError):
        validate_manifest(m)


def _zip_with(name, data=b"x"):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr(name, data)
    return buf.getvalue()


def test_zip_slip_rejected():
    with pytest.raises(BundleError):
        unpack(_zip_with("../escape.txt"))


def test_absolute_path_rejected():
    with pytest.raises(BundleError):
        unpack(_zip_with("/etc/evil"))


def test_too_many_entries_rejected():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for i in range(5001):
            zf.writestr(f"f{i}.txt", b"x")
    with pytest.raises(BundleError):
        unpack(buf.getvalue())


def test_newer_format_version_rejected(skill_store):
    # A bundle from a future OpenSwarm should fail clearly, not half-import.
    buf = io.BytesIO()
    manifest = {
        "format_version": 999,
        "bundle_id": "b",
        "root": {"type": "skill", "bundle_id": "x", "name": "n", "path": "entities/x"},
        "entities": [{"type": "skill", "bundle_id": "x", "name": "n", "path": "entities/x"}],
        "preview": {"root_type": "skill", "root_name": "n"},
    }
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("manifest.json", json.dumps(manifest))
        zf.writestr("entities/x/payload.json", json.dumps({"slug": "n", "name": "n", "content": "c"}))
    with pytest.raises(BundleError):
        closure.stage_upload(buf.getvalue(), "x.swarm")
