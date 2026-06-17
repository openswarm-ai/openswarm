"""Tests for the #9 item 2 pre-extracted node_modules path.

The packaged Windows build ships node_modules ALREADY EXTRACTED in resources so a
workspace junctions straight at it with zero first-app tar-extract. _ensure_warm_cache
must prefer that tree over the .tar.gz / npm paths, and must be a no-op (return None)
when no tree is shipped so Mac and older builds fall back unchanged.
"""
import os

from backend.apps.outputs import view_builder_templates as vt


def test_prefers_bundled_extracted_tree(monkeypatch, tmp_path):
    digest = vt._warm_cache_digest()
    # Force a home-cache miss so we exercise the bundled path.
    monkeypatch.setenv("OPENSWARM_WEBAPP_CACHE_DIR", str(tmp_path / "home"))
    bundle = tmp_path / "resources_cache"
    monkeypatch.setattr(vt, "_BUNDLED_ARCHIVE_DIR", str(bundle))
    nm = bundle / digest / "node_modules" / "vite" / "bin"
    nm.mkdir(parents=True)
    (nm / "vite.js").write_text("// fake")

    expected = str(bundle / digest / "node_modules")
    assert vt._bundled_extracted_modules() == expected
    # Zero extract / zero npm: returns the read-only resources tree directly.
    assert vt._ensure_warm_cache() == expected


def test_no_bundled_tree_returns_none(monkeypatch, tmp_path):
    # No extracted tree shipped (Mac / older builds): must not select it, so the
    # caller falls through to the .tar.gz extract or live npm.
    monkeypatch.setattr(vt, "_BUNDLED_ARCHIVE_DIR", str(tmp_path / "empty"))
    assert vt._bundled_extracted_modules() is None
