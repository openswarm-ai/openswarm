"""Regression tests for the skill-registry never-empty seed (winv2 Bug #1).

The bug: the catalog was fetched from GitHub once at startup then only hourly,
so a cold/slow/failed network left it empty for the whole session, breaking the
Skills page and the onboarding "Install a skill" step (waitForSelector
"skill-item-pdf" timing out). Fix: seed from a bundled snapshot + on-disk
last-good cache so the catalog is never empty, even fully offline.
"""
import asyncio
import json
import os

from backend.apps.skill_registry import skill_registry as sr


def test_bundled_snapshot_exists_and_includes_pdf():
    # The onboarding step targets the "pdf" skill via /pdf/i; it must be present in the shipped snapshot or the tour times out even with a populated list.
    assert os.path.exists(sr.BUNDLED_SNAPSHOT)
    data = json.load(open(sr.BUNDLED_SNAPSHOT, encoding="utf-8"))
    assert isinstance(data, dict) and len(data) >= 10
    assert any("pdf" in k.lower() or "pdf" in v.get("folder", "").lower()
               for k, v in data.items())


def test_seed_makes_catalog_non_empty_offline(monkeypatch, tmp_path):
    # Point the disk cache at an empty tmp dir so only the bundled snapshot can seed; this is the brand-new-install, no-network case.
    monkeypatch.setenv("OPENSWARM_SKILL_CACHE_DIR", str(tmp_path))
    seeded = sr.load_seed_cache()
    assert len(seeded) >= 10

    sr.CACHE = seeded
    res = asyncio.run(sr.registry_search(q="", limit=100, offset=0, sort="name", category=""))
    assert res["total"] >= 10 and len(res["skills"]) >= 10


def test_disk_cache_roundtrip_and_priority(monkeypatch, tmp_path):
    # A saved last-good fetch must win over the bundled snapshot on next boot.
    monkeypatch.setenv("OPENSWARM_SKILL_CACHE_DIR", str(tmp_path))
    sentinel = {"only-skill": {"name": "only-skill", "description": "", "content": "",
                               "folder": "skills/only-skill", "category": "Test",
                               "repositoryUrl": ""}}
    sr.save_disk_cache(sentinel)
    assert os.path.exists(sr.disk_cache_path())
    assert sr.load_seed_cache() == sentinel
