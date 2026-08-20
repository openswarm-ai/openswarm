"""ENG-363: a Connect that survives a backend restart.

The user clicks Connect, the browser leaves for Anthropic, the backend restarts for any reason, and
the returning callback used to find nothing and render "Session expired" while Settings spun
forever. Haik reported that as "Model connection for anthropic does not work". The state is ours to
keep, so keeping it is the fix; there is nothing for the user to retry.
"""

import json
import os
import time

import pytest


@pytest.fixture()
def p_store(monkeypatch, tmp_path):
    import backend.apps.oauth_state as st
    monkeypatch.setattr(st, "PENDING_PATH", str(tmp_path / "pending_oauth.json"), raising=True)
    monkeypatch.setattr(st, "DATA_ROOT", str(tmp_path), raising=True)
    return st


def test_a_pending_flow_survives_a_restart(p_store):
    p_store.pending_oauth["state-abc"] = {
        "provider": "claude", "code_verifier": "v", "redirect_uri": "http://localhost:20128/cb",
    }
    # A restart is a brand new object over the same file; the old process kept nothing.
    fresh = p_store.PendingOAuth()
    found = fresh.pop("state-abc")
    assert found is not None, "the callback must still recognise its own flow"
    assert found["code_verifier"] == "v"


def test_consuming_a_flow_deletes_the_verifier(p_store):
    p_store.pending_oauth["state-abc"] = {"provider": "claude", "code_verifier": "secret"}
    p_store.pending_oauth.pop("state-abc")
    on_disk = json.load(open(p_store.PENDING_PATH))
    assert on_disk == {}, "a single-use secret must not outlive its use"


def test_an_abandoned_flow_ages_out(p_store):
    p_store.pending_oauth["stale"] = {"provider": "claude", "code_verifier": "x"}
    raw = json.load(open(p_store.PENDING_PATH))
    raw["stale"]["stored_at"] = time.time() - (p_store.PENDING_TTL_S + 60)
    open(p_store.PENDING_PATH, "w").write(json.dumps(raw))
    assert p_store.pending_oauth.get("stale") is None
    assert "stale" not in p_store.pending_oauth


def test_the_verifier_is_not_world_readable(p_store):
    p_store.pending_oauth["state-abc"] = {"provider": "claude", "code_verifier": "secret"}
    mode = os.stat(p_store.PENDING_PATH).st_mode & 0o777
    assert mode == 0o600, f"pending verifiers must be owner-only, got {oct(mode)}"


def test_a_corrupt_file_never_blocks_connecting(p_store):
    """Negative control: unreadable state must degrade to 'no pending flow', never to an exception
    that makes Connect impossible forever."""
    open(p_store.PENDING_PATH, "w").write("{not json")
    assert p_store.pending_oauth.get("anything") is None
    p_store.pending_oauth["fresh"] = {"provider": "claude", "code_verifier": "v"}
    assert p_store.pending_oauth.get("fresh") is not None, "a new flow still works"


def test_an_unknown_state_is_still_unknown(p_store):
    """Negative control: durability must not make the handler accept a state nobody issued."""
    assert p_store.pending_oauth.pop("never-issued") is None
