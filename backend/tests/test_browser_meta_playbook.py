"""Cross-site meta-playbook (browser memory tier 3): seeds on day one, absorbs
site-agnostic lessons with no extra LLM call, dedups + caps, survives a restart."""
import tempfile

import pytest

from backend.apps.agents.browser import browser_meta_playbook as meta


@pytest.fixture(autouse=True)
def isolated(monkeypatch):
    monkeypatch.setenv("OPENSWARM_BROWSER_META_DIR", tempfile.mkdtemp(prefix="meta_test_"))
    meta.clear(wipe_disk=True)
    yield
    meta.clear(wipe_disk=True)


def test_seeded_on_day_one():
    b = meta.get_meta()
    assert len(b) >= 4
    assert any("composer" in x.lower() and "clear" in x.lower() for x in b)
    assert "General web priors" in meta.format_for_prompt()


def test_absorb_adds_dedups_and_caps():
    n0 = len(meta.get_meta())
    assert meta.absorb(["clicking a date opens a picker, it is not a navigation"]) is True
    assert len(meta.get_meta()) == n0 + 1
    # identical lesson (case-insensitive) doesn't grow it
    assert meta.absorb(["Clicking a DATE opens a picker, it is not a navigation"]) is False
    # empty input is a no-op
    assert meta.absorb([]) is False
    # capped: flooding never exceeds the cap
    meta.absorb([f"unique universal lesson number {i}" for i in range(50)])
    assert len(meta.get_meta()) <= meta._MAX_BULLETS


def test_survives_a_restart():
    meta.absorb(["a durable cross-site lesson worth keeping"])
    meta.clear(wipe_disk=False)          # in-memory gone, disk intact (== restart)
    assert meta._cache is None
    assert any("durable cross-site lesson" in x for x in meta.get_meta())


def test_secrets_never_persist_into_meta():
    meta.absorb(["the login token is sk-ant-api03-deadbeef and it works"])
    blob = " ".join(meta.get_meta())
    assert "sk-ant-api03" not in blob
