"""Shared test fixtures.

Isolate the persistent browser-skill store (and metrics) into throwaway temp
dirs for the whole test session, so tests never write skills/metrics into the
real ~/Library/Application Support/OpenSwarm/data tree (which would pollute the
dev machine and let a stale persisted skill leak across test runs).
"""

import tempfile

import pytest


@pytest.fixture(autouse=True)
def _isolate_browser_state(monkeypatch):
    skills_dir = tempfile.mkdtemp(prefix="os_skills_")
    metrics_dir = tempfile.mkdtemp(prefix="os_metrics_")
    playbook_dir = tempfile.mkdtemp(prefix="os_playbook_")
    monkeypatch.setenv("OPENSWARM_BROWSER_SKILLS_DIR", skills_dir)
    monkeypatch.setenv("OPENSWARM_BROWSER_METRICS_DIR", metrics_dir)
    monkeypatch.setenv("OPENSWARM_BROWSER_PLAYBOOK_DIR", playbook_dir)

    def _reset():
        for mod in ("browser_skills", "browser_playbook"):
            try:
                m = __import__(f"backend.apps.agents.browser.{mod}", fromlist=[mod])
                m.clear(wipe_disk=True)
            except Exception:
                pass
        # metrics caches its dir at first use; drop it so each test writes
        # where ITS env var points, not where the first test's pointed
        try:
            from backend.apps.agents.browser import browser_metrics as _bm
            _bm._metrics_dir_cache = None
        except Exception:
            pass
    _reset()
    yield
    _reset()
