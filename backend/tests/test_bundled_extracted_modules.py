"""Tests for the #9 item 2 pre-extracted node_modules path.

The packaged Windows build ships node_modules ALREADY EXTRACTED in resources so a
workspace junctions straight at it with zero first-app tar-extract. ensure_warm_cache
must prefer that tree over the .tar.gz / npm paths, and must be a no-op (return None)
when no tree is shipped so Mac and older builds fall back unchanged.
"""
import os

from backend.apps.outputs import view_builder_templates as vt


def test_prefers_bundled_extracted_tree(monkeypatch, tmp_path):
    digest = vt.warm_cache_digest()
    # Force a home-cache miss so we exercise the bundled path.
    monkeypatch.setenv("OPENSWARM_WEBAPP_CACHE_DIR", str(tmp_path / "home"))
    bundle = tmp_path / "resources_cache"
    monkeypatch.setattr(vt, "P_BUNDLED_ARCHIVE_DIR", str(bundle))
    nm = bundle / digest / "node_modules" / "vite" / "bin"
    nm.mkdir(parents=True)
    (nm / "vite.js").write_text("// fake")

    expected = str(bundle / digest / "node_modules")
    assert vt.bundled_extracted_modules() == expected
    # Zero extract / zero npm: returns the read-only resources tree directly.
    assert vt.ensure_warm_cache() == expected


def test_no_bundled_tree_returns_none(monkeypatch, tmp_path):
    # No extracted tree shipped (Mac / older builds): must not select it, so the caller falls through to the .tar.gz extract or live npm.
    monkeypatch.setattr(vt, "P_BUNDLED_ARCHIVE_DIR", str(tmp_path / "empty"))
    assert vt.bundled_extracted_modules() is None


def test_warm_cache_is_complete_requires_launch_bin(tmp_path):
    # A package tree on disk is NOT a finished install; the .bin/vite launch shim is what proves npm finished its bin-linking phase.
    nm = tmp_path / "node_modules"
    (nm / "vite" / "bin").mkdir(parents=True)
    (nm / "vite" / "bin" / "vite.js").write_text("// vite")
    assert vt.warm_cache_is_complete(str(nm)) is False
    bindir = nm / ".bin"
    bindir.mkdir()
    (bindir / "vite").symlink_to("../vite/bin/vite.js")
    assert vt.warm_cache_is_complete(str(nm)) is True


def test_ensure_warm_cache_wipes_partial_and_never_returns_incomplete(monkeypatch, tmp_path):
    # A half-finished cache (package tree present, .bin/vite missing) must be WIPED and never handed back, so no workspace symlinks to an unlaunchable tree and run.sh is never pushed into installing through the shared cache.
    digest = vt.warm_cache_digest()
    home = tmp_path / "home"
    monkeypatch.setenv("OPENSWARM_WEBAPP_CACHE_DIR", str(home))
    cache_modules = home / digest / "node_modules"
    (cache_modules / "vite" / "bin").mkdir(parents=True)
    (cache_modules / "vite" / "bin" / "vite.js").write_text("// vite")
    assert vt.warm_cache_is_complete(str(cache_modules)) is False

    # No bundled tree, no archive, no npm: the only honest answer is "not ready" (None), and the broken tree must be gone, not cached for the next caller.
    monkeypatch.setattr(vt, "P_BUNDLED_ARCHIVE_DIR", str(tmp_path / "noresources"))
    monkeypatch.setattr(vt, "p_try_extract_bundled_archive", lambda *a, **k: False)
    monkeypatch.setattr(vt, "p_resolve_npm", lambda: None)

    assert vt.ensure_warm_cache() is None
    assert not cache_modules.exists()
