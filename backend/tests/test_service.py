"""Tests for the service-sync layer.

Public surface is a single `sync(data)` function. The desktop hands off
opaque dicts; the cloud determines what they are. Tests verify:

  - Envelope (install_id, user_id) stamped on every submission
  - Opt-out gate works
  - Test sink intercepts every sync
  - Spool round-trip (enqueue/drain/acknowledge)
  - Legacy shims (submit, record, identify) route through sync

Run:
    cd backend && python -m pytest tests/test_service.py -v
"""

from __future__ import annotations

import json
import os
import tempfile
import time
from unittest.mock import patch

import pytest

_tmpdir = tempfile.mkdtemp()
os.environ.setdefault("OPENSWARM_DATA_DIR", _tmpdir)


@pytest.fixture(autouse=True)
def patch_settings(tmp_path):
    sf = tmp_path / "settings.json"
    sf.write_text(json.dumps({
        "installation_id": "test-install-abc",
        "analytics_opt_in": True,
    }))
    import backend.apps.settings.settings as settings_mod
    old = settings_mod.SETTINGS_FILE
    settings_mod.SETTINGS_FILE = str(sf)
    yield
    settings_mod.SETTINGS_FILE = old


@pytest.fixture(autouse=True)
def fresh_client(tmp_path):
    import backend.apps.service.client as client
    client._install_id = None
    client._user_id = None
    client._test_sink = None
    spool = tmp_path / "spool.db"
    with patch.object(client, "_spool_path", lambda: str(spool)):
        yield


@pytest.fixture
def sink():
    captured: list[tuple[str, dict]] = []
    import backend.apps.service.client as client
    client.set_test_sink(lambda kind, body: captured.append((kind, body)))
    yield captured
    client.set_test_sink(None)


# --- core sync ---------------------------------------------------------------

def test_sync_basic(sink):
    from backend.apps.service.client import sync
    sync({"foo": "bar"})
    assert len(sink) == 1
    _, body = sink[0]
    assert body["d"] == {"foo": "bar"}


def test_sync_carries_install_id(sink):
    from backend.apps.service.client import sync
    sync({})
    _, body = sink[0]
    assert body["client_state"]["install_id"] == "test-install-abc"


def test_sync_carries_user_id_when_set(sink):
    from backend.apps.service.client import sync, set_user_id
    set_user_id("alice@example.com")
    sync({})
    _, body = sink[0]
    assert body["client_state"]["user_id"] == "alice@example.com"


def test_sync_no_user_id_when_not_set(sink):
    from backend.apps.service.client import sync
    sync({})
    _, body = sink[0]
    assert "user_id" not in body["client_state"]


def test_sync_user_id_cleared_with_none(sink):
    from backend.apps.service.client import sync, set_user_id
    set_user_id("alice")
    set_user_id(None)
    sync({})
    _, body = sink[0]
    assert "user_id" not in body["client_state"]


def test_sync_user_id_cleared_with_empty(sink):
    from backend.apps.service.client import sync, set_user_id
    set_user_id("alice")
    set_user_id("")
    sync({})
    _, body = sink[0]
    assert "user_id" not in body["client_state"]


def test_sync_environment_metadata(sink):
    from backend.apps.service.client import sync
    sync({})
    _, body = sink[0]
    cs = body["client_state"]
    assert cs.get("device_type") == "desktop"
    assert cs.get("os")
    assert cs.get("os_version")


def test_sync_payload_round_trips(sink):
    from backend.apps.service.client import sync
    data = {"deeply": {"nested": [1, 2]}, "flag": True, "n": 3.14}
    sync(data)
    _, body = sink[0]
    assert body["d"] == data


def test_sync_empty_data(sink):
    from backend.apps.service.client import sync
    sync({})
    assert len(sink) == 1


def test_sync_none_treated_as_empty(sink):
    from backend.apps.service.client import sync
    sync(None)
    _, body = sink[0]
    assert body["d"] == {}


def test_sync_timestamp_present(sink):
    from backend.apps.service.client import sync
    sync({})
    _, body = sink[0]
    assert isinstance(body["t"], float)
    assert body["t"] > 0


# --- opt-out gating ----------------------------------------------------------

def test_opt_out_blocks_sync(sink, tmp_path):
    sf = tmp_path / "minimal.json"
    sf.write_text(json.dumps({
        "installation_id": "test-install-abc",
        "analytics_opt_in": False,
    }))
    import backend.apps.settings.settings as settings_mod
    settings_mod.SETTINGS_FILE = str(sf)
    from backend.apps.service.client import sync
    sync({"x": 1})
    assert sink == []


def test_standard_mode_allows_sync(sink):
    from backend.apps.service.client import sync
    sync({})
    sync({})
    assert len(sink) == 2


def test_settings_load_failure_defaults_to_enabled(sink):
    import backend.apps.settings.settings as settings_mod
    settings_mod.SETTINGS_FILE = "/nonexistent/path/settings.json"
    from backend.apps.service.client import sync
    sync({})
    assert len(sink) == 1


# --- legacy shims ------------------------------------------------------------

def test_legacy_submit_routes_through_sync(sink):
    from backend.apps.service.client import submit
    submit("event", {"test": True})
    assert len(sink) == 1
    _, body = sink[0]
    assert body["d"] == {"test": True}


def test_legacy_record_routes_through_sync(sink):
    from backend.apps.service.client import record
    record("some.event", {"k": "v"})
    assert len(sink) == 1


def test_legacy_identify_routes_through_sync(sink):
    from backend.apps.service.client import identify
    identify({"plan": "pro"})
    assert len(sink) == 1


def test_legacy_submit_session_close(sink):
    from backend.apps.service.client import submit_session_close
    submit_session_close({"id": "s-1", "cost_usd": 0.42})
    assert len(sink) == 1


def test_legacy_submit_diagnostic(sink):
    from backend.apps.service.client import submit_diagnostic
    submit_diagnostic({"kind": "error_caught"})
    assert len(sink) == 1


# --- spool -------------------------------------------------------------------

def test_buffer_enqueue_and_drain(tmp_path):
    from backend.apps.service import buffer
    spool = str(tmp_path / "s.db")
    buffer.enqueue(spool, "s:/api/service/sync", {"a": 1}, now=time.time())
    buffer.enqueue(spool, "s:/api/service/sync", {"a": 2}, now=time.time())
    assert buffer.count(spool) == 2
    rows = buffer.drain(spool, batch_size=10)
    assert [r[2]["a"] for r in rows] == [1, 2]
    buffer.acknowledge(spool, [r[0] for r in rows])
    assert buffer.count(spool) == 0


def test_buffer_drain_partial(tmp_path):
    from backend.apps.service import buffer
    spool = str(tmp_path / "s.db")
    for i in range(5):
        buffer.enqueue(spool, "s:/x", {"i": i}, now=time.time())
    rows = buffer.drain(spool, batch_size=2)
    assert len(rows) == 2
    assert buffer.count(spool) == 5
    buffer.acknowledge(spool, [r[0] for r in rows])
    assert buffer.count(spool) == 3


def test_buffer_clear(tmp_path):
    from backend.apps.service import buffer
    spool = str(tmp_path / "s.db")
    buffer.enqueue(spool, "s:/x", {}, now=time.time())
    buffer.clear(spool)
    assert buffer.count(spool) == 0


def test_buffer_missing_file(tmp_path):
    from backend.apps.service import buffer
    assert buffer.count(str(tmp_path / "nope.db")) == 0
    assert buffer.drain(str(tmp_path / "nope.db")) == []


def test_buffer_corrupt_row_dropped(tmp_path):
    from backend.apps.service import buffer
    spool = str(tmp_path / "s.db")
    with buffer._conn(spool) as c:
        c.execute(
            "INSERT INTO spool (kind, payload, created_at) VALUES (?, ?, ?)",
            ("s:/x", "{not json", time.time()),
        )
    rows = buffer.drain(spool)
    assert rows == []
    assert buffer.count(spool) == 0


def test_buffer_size_cap(tmp_path):
    from backend.apps.service import buffer
    spool = str(tmp_path / "s.db")
    big = "x" * 1024
    for i in range(200):
        buffer.enqueue(spool, "s:/x", {"i": i, "pad": big}, now=time.time())
    assert buffer.count(spool) == 200


@pytest.mark.asyncio
async def test_drain_spool_empty():
    from backend.apps.service.client import drain_spool
    n = await drain_spool()
    assert n == 0


# --- identity ----------------------------------------------------------------

def test_install_id_persisted(sink, tmp_path):
    sf = tmp_path / "fresh.json"
    sf.write_text(json.dumps({"analytics_opt_in": True}))
    import backend.apps.settings.settings as settings_mod
    settings_mod.SETTINGS_FILE = str(sf)
    import backend.apps.service.client as client
    client._install_id = None
    from backend.apps.service.client import sync
    sync({})
    _, body = sink[0]
    iid = body["client_state"]["install_id"]
    assert iid
    raw = json.loads(sf.read_text())
    assert raw["installation_id"] == iid


def test_install_id_stable(sink):
    from backend.apps.service.client import sync
    sync({})
    sync({})
    iid1 = sink[0][1]["client_state"]["install_id"]
    iid2 = sink[1][1]["client_state"]["install_id"]
    assert iid1 == iid2


# --- SubApp endpoints --------------------------------------------------------

@pytest.mark.asyncio
async def test_endpoint_submit(sink):
    from backend.apps.service.service import post_submit
    res = await post_submit({"kind": "state", "payload": {"x": 1}})
    assert res == {"ok": True}
    assert len(sink) == 1


@pytest.mark.asyncio
async def test_endpoint_submit_missing_payload(sink):
    from backend.apps.service.service import post_submit
    res = await post_submit({"kind": "state"})
    assert res["ok"] is False


@pytest.mark.asyncio
async def test_endpoint_event_happy(sink):
    from backend.apps.service.service import post_event
    res = await post_event({"surface": "test", "action": "happy"})
    assert res == {"ok": True}
    assert len(sink) == 1


@pytest.mark.asyncio
async def test_endpoint_event_missing_surface(sink):
    from backend.apps.service.service import post_event
    res = await post_event({"action": "x"})
    assert res["ok"] is False


@pytest.mark.asyncio
async def test_endpoint_spool_count(tmp_path):
    from backend.apps.service import client as svc, buffer
    from backend.apps.service.service import spool_count
    spool = str(tmp_path / "spool.db")
    with patch.object(svc, "_spool_path", lambda: spool):
        buffer.enqueue(spool, "s:/x", {}, now=time.time())
        result = await spool_count()
        assert result == {"pending": 1}
