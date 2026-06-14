"""On-disk robustness: a single corrupt JSON file must never brick boot or a page,
schema-mismatched files must be skipped but preserved (recoverable), and every
store write must be crash-safe (temp + replace, no truncation, no temp leak)."""
import json
import os

import pytest

from backend.config.json_store import read_json_or_none, atomic_write_json


class _NotSerializable:
    pass


# ---------------- atomic_write_json ----------------

def test_atomic_write_roundtrip_utf8(tmp_path):
    p = str(tmp_path / "x.json")
    atomic_write_json(p, {"a": 1, "z": "unicode-snowman-☃"})
    assert read_json_or_none(p) == {"a": 1, "z": "unicode-snowman-☃"}


def test_atomic_write_leaves_no_temp_on_success(tmp_path):
    atomic_write_json(str(tmp_path / "x.json"), {"a": 1})
    assert [f for f in os.listdir(tmp_path) if f.startswith(".tmp-")] == []


def test_atomic_write_fully_replaces(tmp_path):
    p = str(tmp_path / "x.json")
    atomic_write_json(p, {"old": "x" * 5000})
    atomic_write_json(p, {"new": 1})
    assert read_json_or_none(p) == {"new": 1}


def test_atomic_write_cleans_temp_and_raises_on_bad_payload(tmp_path):
    p = str(tmp_path / "x.json")
    with pytest.raises(TypeError):
        atomic_write_json(p, {"bad": _NotSerializable()})
    assert [f for f in os.listdir(tmp_path) if f.startswith(".tmp-")] == []
    assert not os.path.exists(p)


def test_atomic_write_preserves_existing_when_new_write_fails(tmp_path):
    p = str(tmp_path / "x.json")
    atomic_write_json(p, {"good": 1})
    with pytest.raises(TypeError):
        atomic_write_json(p, {"bad": _NotSerializable()})
    assert read_json_or_none(p) == {"good": 1}


# ---------------- read_json_or_none ----------------

def test_read_missing_returns_none(tmp_path):
    assert read_json_or_none(str(tmp_path / "nope.json")) is None


def test_read_truncated_returns_none(tmp_path):
    p = tmp_path / "bad.json"
    p.write_text('{"a": 1, trunca')
    assert read_json_or_none(str(p)) is None


def test_read_binary_garbage_returns_none(tmp_path):
    p = tmp_path / "bad.json"
    p.write_bytes(b"\xff\xfe\x00\x01\x02not json")
    assert read_json_or_none(str(p)) is None


def test_read_empty_file_returns_none(tmp_path):
    p = tmp_path / "empty.json"
    p.write_text("")
    assert read_json_or_none(str(p)) is None


# ---------------- session store (the boot-brick path) ----------------

def test_sessions_skip_corrupt_and_roundtrip(tmp_path, monkeypatch):
    from backend.apps.agents import agent_manager as am
    monkeypatch.setattr(am, "SESSIONS_DIR", str(tmp_path))
    am._save_session("good", {"id": "good", "v": 1})
    (tmp_path / "bad.json").write_text("{ truncated session ,,,")
    loaded = dict(am._load_all_session_data())
    assert loaded == {"good": {"id": "good", "v": 1}}
    assert (tmp_path / "bad.json").exists()  # corrupt file preserved, not deleted
    assert am._load_session_data("good") == {"id": "good", "v": 1}
    assert am._load_session_data("bad") is None  # single corrupt load -> None, no raise


# ---------------- dashboards / modes / outputs load-all ----------------

def test_dashboards_load_all_skips_corrupt_and_invalid(tmp_path, monkeypatch):
    from backend.apps.dashboards import dashboards as dmod
    from backend.apps.dashboards.models import Dashboard, DashboardLayout
    monkeypatch.setattr(dmod, "DATA_DIR", str(tmp_path))
    dmod._save(Dashboard(name="good", layout=DashboardLayout()))
    (tmp_path / "garbled.json").write_text("{ not json")
    # Valid JSON the model can't accept (a list can't be **-unpacked into the model).
    # Models are lenient about missing/extra fields, so this is what an unloadable file actually looks like.
    (tmp_path / "wrongshape.json").write_text(json.dumps([1, 2, 3]))
    loaded = dmod._load_all()
    assert [d.name for d in loaded] == ["good"]
    # both bad files preserved on disk (decode error + unloadable shape are non-destructive)
    assert (tmp_path / "garbled.json").exists()
    assert (tmp_path / "wrongshape.json").exists()


def test_modes_load_all_skips_corrupt(tmp_path, monkeypatch):
    from backend.apps.modes import modes as mmod
    from backend.apps.modes.models import Mode
    monkeypatch.setattr(mmod, "DATA_DIR", str(tmp_path))
    mmod._save(Mode(name="good"))
    (tmp_path / "garbled.json").write_text("{{{")
    loaded = mmod._load_all()
    assert [m.name for m in loaded] == ["good"]
    assert (tmp_path / "garbled.json").exists()


def test_outputs_load_all_skips_corrupt(tmp_path, monkeypatch):
    from backend.apps.outputs import outputs as omod
    from backend.apps.outputs import workspace_io as wio
    from backend.apps.outputs.models import Output
    # _load_all/_save live in workspace_io after the structure refactor; patch where they read DATA_DIR.
    monkeypatch.setattr(wio, "DATA_DIR", str(tmp_path))
    omod._save(Output(name="good"))
    (tmp_path / "garbled.json").write_text("nope")
    loaded = omod._load_all()
    assert [o.name for o in loaded] == ["good"]
    assert (tmp_path / "garbled.json").exists()


# ---------------- dashboard migration must not half-apply ----------------

def test_migration_survives_corrupt_session(tmp_path, monkeypatch):
    from backend.apps.dashboards import dashboards as dmod
    dash_dir = tmp_path / "dash"
    sess_dir = tmp_path / "sessions"
    dash_dir.mkdir()
    sess_dir.mkdir()
    monkeypatch.setattr(dmod, "DATA_DIR", str(dash_dir))
    monkeypatch.setattr(dmod, "SESSIONS_DIR", str(sess_dir))
    monkeypatch.setattr(dmod, "OLD_LAYOUT_FILE", str(tmp_path / "no_old_layout.json"))
    (sess_dir / "good.json").write_text(json.dumps({"id": "good"}))
    (sess_dir / "bad.json").write_text("{ truncated ,,,")

    dmod._migrate_if_needed()  # must not raise despite the corrupt session

    dashboards = dmod._load_all()
    assert len(dashboards) == 1
    tagged = read_json_or_none(str(sess_dir / "good.json"))
    assert tagged["dashboard_id"] == dashboards[0].id  # good session tagged
    assert (sess_dir / "bad.json").exists()  # corrupt one skipped, left intact
