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


def p_make_skill(d, slug, name, content, description="desc"):
    (d / f"{slug}.md").write_text(content, encoding="utf-8")
    index = store.load_index()
    index[slug] = {"name": name, "description": description, "command": slug}
    store.save_index(index)


def test_skill_export_import_round_trip(skill_store):
    p_make_skill(skill_store, "my-skill", "My Skill", "# hello\nbody text")
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
    assert (skill_store / "my-skill.md").exists()  # original flat skill untouched
    assert (skill_store / root_id / "SKILL.md").read_text(encoding="utf-8") == "# hello\nbody text"
    assert created == {"skill": [root_id]}


def test_bare_markdown_import(skill_store):
    sandbox, manifest, warnings = closure.stage_upload(b"# Just markdown", "Cool Trick.md")
    try:
        assert manifest.root.type == EntityType.skill
        assert manifest.root.name == "Cool Trick"
        p_t, root_id, created, p_u = closure.commit(sandbox, manifest, [])
    finally:
        import shutil
        shutil.rmtree(sandbox, ignore_errors=True)
    assert (skill_store / root_id / "SKILL.md").read_text(encoding="utf-8") == "# Just markdown"


def test_content_secret_redacted_in_bundle(skill_store):
    secret = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA"
    p_make_skill(skill_store, "leaky", "Leaky", f"use this key: {secret}")
    raw, p_name = closure.build_bundle(EntityType.skill, "leaky")
    # Inspect the actual packed payload (zip entries are compressed, so grepping the raw bytes proves nothing).
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
    # A key hardcoded in app source (not .env) must not ride along; pack scans file bytes, not just payload keys.
    leak = b"const KEY = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA';\n"
    with pytest.raises(BundleError):
        pack({"format_version": 1}, {"bid1": {"name": "ok"}}, {"entities/bid1/files/config.js": leak})


def test_pack_allows_clean_workspace_file():
    raw = pack({"format_version": 1}, {"bid1": {"name": "ok"}}, {"entities/bid1/files/app.js": b"export default 1"})
    assert zipfile.is_zipfile(io.BytesIO(raw))


def test_app_export_drops_machine_env(tmp_path, monkeypatch):
    # The live .env holds the source machine's absolute paths + pinned port; it must never ride along. .env.example (portable) does.
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
    from backend.apps.swarm.entities.workflows import sanitize_workflow
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
    out = sanitize_workflow(raw)
    # An imported workflow must not auto-run or carry the sharer's identity.
    assert out["schedule"]["enabled"] is False
    assert out["schedule"]["runs_count"] == 0
    assert out["schedule"]["hour"] == 9  # cadence shape preserved
    assert out["permissions"][0]["phone"] is None
    for dropped in ("id", "source_session_id", "dashboard_id", "last_run_status"):
        assert dropped not in out
    assert out["title"] == "Daily digest"


def test_workflow_round_trips_through_the_store(isolated_workflows_data):
    # The workflow store landed on this branch, so a workflow bundle imports into an (isolated) store: an unknown id loads as None, import_ creates a fresh row with its schedule forced OFF (so an imported workflow never auto-runs on someone else's machine), and load reads it back. Supersedes test_workflow_unavailable_on_this_branch, which dated from before the workflow store was on eric/dev.
    from backend.apps.swarm.entities.workflows import WorkflowExportable
    from backend.apps.swarm.exportable import RemapTable
    from backend.apps.workflows import storage
    assert WorkflowExportable.load("nonexistent") is None
    new_id = WorkflowExportable.import_(
        {"title": "Shared WF", "schedule": {"enabled": True}}, {}, RemapTable()
    )
    assert new_id
    loaded = WorkflowExportable.load(new_id)
    assert loaded is not None
    assert loaded.name == "Shared WF"
    # Read the persisted row back through the store's public API (not the entity's private data) to confirm the schedule was forced off on import.
    saved = storage.get_workflow(new_id)
    assert saved is not None and saved.schedule.enabled is False


def test_session_export_carries_transcript_drops_runtime_and_secrets():
    from backend.apps.swarm.entities.SessionExportable import SessionExportable
    from backend.apps.swarm.redact import scrub_payload
    data = {
        "name": "A", "provider": "anthropic", "model": "sonnet", "mode": "agent",
        "system_prompt": "hi", "allowed_tools": ["Read"],
        "messages": [
            {"id": "m1", "role": "user", "content": "private chat", "branch_id": "main"},
            {"id": "m2", "role": "assistant", "content": "token is sk-ant-abcdefghij0123456789"},
        ],
        "branches": {"main": {"id": "main", "parent_branch_id": None, "fork_point_message_id": None}},
        "active_branch_id": "main",
        "tool_group_meta": {"g1": {"label": "x"}},
        "active_mcps": ["Gmail"], "cwd": "/Users/me/repo", "cost_usd": 9.9, "sdk_session_id": "x",
    }
    ex = SessionExportable("s1", "A", data)
    out = ex.serialize(None)
    # The transcript now rides along, that's the point of sharing an agent.
    assert out["messages"][0]["content"] == "private chat"
    assert out["active_branch_id"] == "main" and "main" in out["branches"]
    assert out["tool_group_meta"] == {"g1": {"label": "x"}}
    # Runtime, identity, and gate state still never leave.
    for gone in ("cwd", "active_mcps", "cost_usd", "sdk_session_id"):
        assert gone not in out
    # The closure runs scrub_payload on every payload, so a secret-shaped string sitting in the transcript is redacted before it ships.
    assert "sk-ant-" not in json.dumps(scrub_payload(out))
    reqs = ex.requirements()
    assert any(r.kind.value == "mcp_action" and r.key == "Gmail" for r in reqs)


def test_session_import_restores_transcript_without_granting_mcp(monkeypatch):
    from backend.apps.swarm.entities.SessionExportable import SessionExportable
    from backend.apps.swarm.exportable import RemapTable
    from backend.apps.agents.manager.session import session_store
    saved: dict = {}
    monkeypatch.setattr(session_store, "save_session", lambda sid, doc: saved.update({sid: doc}))
    payload = {
        "name": "A", "model": "sonnet", "mode": "agent",
        "messages": [{"id": "m1", "role": "user", "content": "hi", "branch_id": "main"}],
        "branches": {"main": {"id": "main", "parent_branch_id": None, "fork_point_message_id": None}},
        "active_branch_id": "main",
        "tool_group_meta": {"g1": {"label": "x"}},
    }
    sid = SessionExportable.import_(payload, {}, RemapTable())
    doc = saved[sid]
    assert doc["messages"][0]["content"] == "hi"
    assert doc["active_branch_id"] == "main"
    assert doc["tool_group_meta"] == {"g1": {"label": "x"}}
    # The gate stays shut: a shared agent never arrives with MCP access.
    assert doc["active_mcps"] == []
    # The dashboard import re-points this; it must never be the sharer's id.
    assert doc["dashboard_id"] is None


def test_session_import_old_bundle_without_transcript(monkeypatch):
    # A bundle made before transcripts were carried has no messages; it must still import as a valid empty-history agent (single main branch), not crash.
    from backend.apps.swarm.entities.SessionExportable import SessionExportable
    from backend.apps.swarm.exportable import RemapTable
    from backend.apps.agents.manager.session import session_store
    saved: dict = {}
    monkeypatch.setattr(session_store, "save_session", lambda sid, doc: saved.update({sid: doc}))
    sid = SessionExportable.import_({"name": "Old", "model": "sonnet"}, {}, RemapTable())
    doc = saved[sid]
    assert doc["messages"] == []
    assert doc["active_branch_id"] == "main" and "main" in doc["branches"]


def test_session_load_prefers_live_memory_over_stale_disk(tmp_path, monkeypatch):
    # The freshest transcript lives in memory; a disk-only load would ship a stale one. load() must read the live session first, disk only as fallback.
    from backend.apps.agents import agent_manager as am
    from backend.apps.swarm.entities.SessionExportable import SessionExportable
    sdir = tmp_path / "sessions"
    sdir.mkdir()
    monkeypatch.setattr(am, "SESSIONS_DIR", str(sdir))
    (sdir / "s1.json").write_text(json.dumps(
        {"name": "Stale", "messages": [{"id": "old", "role": "user", "content": "old"}]}))

    class FakeSess:
        def model_dump(self, mode="json"):
            return {"name": "Live", "messages": [
                {"id": "old", "role": "user", "content": "old"},
                {"id": "new", "role": "assistant", "content": "fresh turn"},
            ]}

    monkeypatch.setattr(am.agent_manager, "sessions", {"s1": FakeSess()})
    out = SessionExportable.load("s1").serialize(None)
    assert out["name"] == "Live"          # not the stale disk copy
    assert len(out["messages"]) == 2      # the unflushed turn is included


def test_dashboard_export_import_carries_agent_cards_and_transcript(tmp_path, monkeypatch):
    # The path the single-session tests missed: a whole dashboard with agent cards + a browser card. Both agents (with their transcripts) and the browser must survive export -> import. An empty-history import is the bug the user hit ("the chats didn't even show up, let alone the history").
    import shutil
    from backend.apps.agents import agent_manager as am
    import backend.config.paths as paths
    sdir = tmp_path / "sessions"
    ddir = tmp_path / "dashboards"
    sdir.mkdir()
    ddir.mkdir()
    monkeypatch.setattr(am, "SESSIONS_DIR", str(sdir))
    monkeypatch.setattr(paths, "DASHBOARDS_DIR", str(ddir))
    monkeypatch.setattr(am.agent_manager, "sessions", {})  # nothing live -> disk path

    did, sid1, sid2, bkey = "d1", "sA", "sB", "browser-1"

    def sess(sid, name, text):
        return {
            "id": sid, "name": name, "status": "completed", "provider": "anthropic",
            "model": "sonnet", "mode": "agent", "allowed_tools": [],
            "messages": [{"id": "m1", "role": "user", "content": text, "branch_id": "main"}],
            "branches": {"main": {"id": "main", "parent_branch_id": None, "fork_point_message_id": None, "created_at": "2026-01-01"}},
            "active_branch_id": "main", "tool_group_meta": {}, "active_mcps": [], "dashboard_id": did,
        }

    (sdir / f"{sid1}.json").write_text(json.dumps(sess(sid1, "Agent One", "from one")))
    (sdir / f"{sid2}.json").write_text(json.dumps(sess(sid2, "Agent Two", "from two")))
    (ddir / f"{did}.json").write_text(json.dumps({"id": did, "name": "Board", "layout": {
        "cards": {sid1: {"session_id": sid1}, sid2: {"session_id": sid2}},
        "view_cards": {},
        "browser_cards": {bkey: {"browser_id": bkey, "url": "u", "spawned_by": None}},
        "notes": {}, "expanded_session_ids": [sid1],
    }}))

    raw, _ = closure.build_bundle(EntityType.dashboard, did)
    sandbox, manifest, p_w = closure.stage_upload(raw, "board.swarm")
    try:
        p_rt, root_id, p_created, p_u = closure.commit(sandbox, manifest, [])
    finally:
        shutil.rmtree(sandbox, ignore_errors=True)

    L = json.loads((ddir / f"{root_id}.json").read_text())["layout"]
    assert len(L["cards"]) == 2, "both agent cards must survive import"
    assert len(L["browser_cards"]) == 1, "the browser card must survive too"
    total_msgs = 0
    for sid in L["cards"]:
        doc = json.loads((sdir / f"{sid}.json").read_text())
        total_msgs += len(doc.get("messages") or [])
        assert doc["active_mcps"] == [], "import must not grant MCP access"
    assert total_msgs == 2, "each agent's transcript must carry through"

    # The bug behind "the chats didn't even show up": after import the sessions are on disk but not in memory, and the dashboard-open fetch (get_all_sessions) was memory-only, so the cards rendered blank. The fetch must now see the freshly-imported sessions straight off disk.
    found = am.agent_manager.get_all_sessions(dashboard_id=root_id)
    assert len(found) == 2, f"dashboard-open fetch must see imported agent sessions, got {len(found)}"
    assert sum(len(s.messages) for s in found) == 2, "and with their transcripts"


def test_get_all_sessions_does_not_resurrect_deleted_cards(tmp_path, monkeypatch):
    # Deleting a card removes it from the layout but the session keeps its dashboard_id on disk. get_all_sessions must surface only sessions the layout still has a card for, or deleted chats come back on every reopen.
    from backend.apps.agents import agent_manager as am
    import backend.config.paths as paths
    sdir = tmp_path / "sessions"
    ddir = tmp_path / "dashboards"
    sdir.mkdir()
    ddir.mkdir()
    monkeypatch.setattr(am, "SESSIONS_DIR", str(sdir))
    monkeypatch.setattr(paths, "DASHBOARDS_DIR", str(ddir))
    monkeypatch.setattr(am.agent_manager, "sessions", {})

    did = "d1"

    def sess(sid):
        return {
            "id": sid, "name": sid, "status": "completed", "model": "sonnet",
            "mode": "agent", "messages": [], "branches": {}, "active_branch_id": "main",
            "dashboard_id": did,
        }

    (sdir / "kept.json").write_text(json.dumps(sess("kept")))
    (sdir / "deleted.json").write_text(json.dumps(sess("deleted")))  # still tagged, card gone
    # The layout has a card only for "kept" (the user deleted "deleted"'s card).
    (ddir / f"{did}.json").write_text(json.dumps({"id": did, "layout": {"cards": {"kept": {"session_id": "kept"}}}}))

    ids = {s.id for s in am.agent_manager.get_all_sessions(dashboard_id=did)}
    assert "kept" in ids, "a session the layout still has a card for must surface"
    assert "deleted" not in ids, "a session whose card was deleted must NOT resurrect"


def test_dashboard_serialize_rewrites_refs_to_bundle_ids():
    from backend.apps.swarm.entities.dashboards import DashboardExportable
    from backend.apps.swarm.models import EntityType

    class Ctx:
        def bundle_id_for(self, t: EntityType, lid: str):
            return {("session", "S"): "SBID", ("app", "A"): "ABID"}.get((t.value, lid))

    data = {"name": "D", "layout": {
        "cards": {"S": {"session_id": "S", "x": 1}},
        "view_cards": {"A": {"output_id": "A", "x": 2, "parent_session_id": "S"}},
        "browser_cards": {"b1": {"browser_id": "b1", "url": "u", "spawned_by": "S"}},
        "expanded_session_ids": ["S"],
    }}
    L = DashboardExportable("d1", "D", data).serialize(Ctx())["layout"]
    assert L["cards"]["SBID"]["session_id"] == "SBID"
    assert L["view_cards"]["ABID"]["output_id"] == "ABID"
    # the app card's tether to its builder agent is a session id, so it remaps too
    assert L["view_cards"]["ABID"]["parent_session_id"] == "SBID"
    assert L["browser_cards"]["b1"]["spawned_by"] == "SBID"
    assert L["expanded_session_ids"] == ["SBID"]


def test_dashboard_import_remaps_to_fresh_local_ids(monkeypatch):
    from backend.apps.swarm.entities import dashboards as dmod
    from backend.apps.swarm.exportable import RemapTable

    written: dict = {}
    monkeypatch.setattr(dmod, "p_write", lambda did, doc: written.update({did: doc}))
    monkeypatch.setattr(dmod, "p_retag_sessions", lambda ids, did: None)
    remap = RemapTable()
    remap.assign("SBID", "newsess")
    remap.assign("ABID", "newapp")
    payload = {"name": "D", "layout": {
        "cards": {"SBID": {"session_id": "SBID"}},
        "view_cards": {
            "ABID": {"output_id": "ABID", "parent_session_id": "SBID"},
            "ABID2": {"output_id": "ABID2", "parent_session_id": "GONE"},
        },
        "browser_cards": {"b1": {"browser_id": "b1", "spawned_by": "SBID"}},
        "expanded_session_ids": ["SBID", "ORPHAN"],
    }}
    remap.assign("ABID2", "newapp2")
    did = dmod.DashboardExportable.import_(payload, {}, remap)
    L = written[did]["layout"]
    assert L["cards"]["newsess"]["session_id"] == "newsess"
    assert L["view_cards"]["newapp"]["parent_session_id"] == "newsess"
    assert L["view_cards"]["newapp2"]["parent_session_id"] is None  # parent not in bundle
    assert list(L["browser_cards"].values())[0]["spawned_by"] == "newsess"
    assert L["expanded_session_ids"] == ["newsess"]  # the dangling ref is dropped


def test_dashboard_remap_invariant_generative(monkeypatch):
    # The hand-written remap tests only check the id-bearing fields I remembered. Generate random dashboards and assert the real invariant on a serialize -> import round-trip: no source-local id and no bundle id survives into the imported layout, and every card id is a freshly-minted local id. This is what catches "someone adds a new layout field holding a session id and forgets to remap it."
    import random

    from backend.apps.swarm.entities import dashboards as dmod
    from backend.apps.swarm.exportable import RemapTable
    from backend.apps.swarm.models import EntityType

    written: dict = {}
    monkeypatch.setattr(dmod, "p_write", lambda did, doc: written.update({did: doc}))
    monkeypatch.setattr(dmod, "p_retag_sessions", lambda ids, did: None)

    rng = random.Random(1234)
    for _ in range(60):
        sess = [f"S{i}" for i in range(rng.randint(0, 5))]
        apps = [f"A{i}" for i in range(rng.randint(0, 4))]
        s_bid = {s: f"sbid{i}" for i, s in enumerate(sess)}
        a_bid = {a: f"abid{i}" for i, a in enumerate(apps)}

        class Ctx:
            def bundle_id_for(self, t, lid):
                if t == EntityType.session:
                    return s_bid.get(lid)
                if t == EntityType.app:
                    return a_bid.get(lid)
                return None

        layout = {
            "cards": {s: {"session_id": s, "x": rng.randint(0, 9)} for s in sess},
            "view_cards": {
                a: {"output_id": a,
                    "parent_session_id": (rng.choice(sess + ["ORPHAN"]) if sess and rng.random() < 0.7 else None)}
                for a in apps
            },
            "browser_cards": {
                f"b{i}": {"browser_id": f"b{i}", "url": "u",
                          "spawned_by": (rng.choice(sess) if sess and rng.random() < 0.7 else None)}
                for i in range(rng.randint(0, 3))
            },
            "expanded_session_ids": (sess + ["ORPHAN"]) if rng.random() < 0.5 else list(sess),
        }
        payload = dmod.DashboardExportable("d-src", "D", {"name": "D", "layout": layout}).serialize(Ctx())

        remap = RemapTable()
        fresh_sess = {s: f"new-{s_bid[s]}" for s in sess}
        fresh_apps = {a: f"new-{a_bid[a]}" for a in apps}
        for s in sess:
            remap.assign(s_bid[s], fresh_sess[s])
        for a in apps:
            remap.assign(a_bid[a], fresh_apps[a])

        did = dmod.DashboardExportable.import_(payload, {}, remap)
        L = written[did]["layout"]

        forbidden = set(sess) | set(apps) | set(s_bid.values()) | set(a_bid.values())
        assert set(L["cards"]) == set(fresh_sess.values())
        assert set(L["view_cards"]) == set(fresh_apps.values())
        for cid, card in L["cards"].items():
            assert cid not in forbidden and card["session_id"] == cid
        for oid, card in L["view_cards"].items():
            assert oid not in forbidden and card["output_id"] == oid
            p = card["parent_session_id"]
            assert p is None or (p in set(fresh_sess.values()) and p not in forbidden)
        assert set(L["expanded_session_ids"]) <= set(fresh_sess.values())
        for card in L["browser_cards"].values():
            assert card["spawned_by"] is None or card["spawned_by"] in set(fresh_sess.values())


def test_checksum_rejects_tampering(skill_store):
    p_make_skill(skill_store, "tmp", "Tmp", "# original")
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
    assert (skill_store / sid / "SKILL.md").exists()
    SkillExportable.rollback(sid)
    assert not (skill_store / sid).exists()
    assert sid not in store.load_index()


def test_commit_rolls_back_created_on_failure(skill_store, tmp_path, monkeypatch):
    # A bundle of [skill, workflow]: the skill imports first and lands, then the workflow import fails, so the skill must be rolled back (all-or-nothing, no half-write). The failure used to come for free (no workflow store on this branch); now the store exists, so force it deterministically by making the workflow import raise.
    from backend.apps.swarm.models import BundlePreview, EntityRef, Manifest
    from backend.apps.swarm.entities.workflows import WorkflowExportable

    def p_boom(*a, **k):
        raise BundleError("simulated workflow import failure")
    monkeypatch.setattr(WorkflowExportable, "import_", p_boom)

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
    assert "rollme" not in store.load_index()
    assert not (skill_store / "rollme").exists()  # the imported folder was rolled back


def test_manifest_duplicate_ids_rejected():
    # Two entities sharing a bundle_id silently collapse in the topo/summary dicts, dropping one; reject up front. (The manifest is outside the checksum.)
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


def p_zip_with(name, data=b"x"):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr(name, data)
    return buf.getvalue()


def test_zip_slip_rejected():
    with pytest.raises(BundleError):
        unpack(p_zip_with("../escape.txt"))


def test_absolute_path_rejected():
    with pytest.raises(BundleError):
        unpack(p_zip_with("/etc/evil"))


def test_symlink_entry_rejected():
    # A symlink entry could point outside the sandbox once followed; unpack must refuse it before writing anything.
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zi = zipfile.ZipInfo("link")
        zi.external_attr = 0o120777 << 16
        zf.writestr(zi, "/etc/passwd")
    with pytest.raises(BundleError):
        unpack(buf.getvalue())


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
