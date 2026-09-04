"""A Windows user imported the Tisusa .swarm (507 workspace files) and got an app card that said
"This app's files are missing" (2026-09-04). The staging reader keyed files with the OS separator,
the app importer looked for `workspace/`, skipped every file, and saved a hollow app. Bundle keys
are slash-separated everywhere now, and a bundle that ships files but none under workspace/ fails
loudly instead of importing a shell."""

import os

import pytest

from backend.apps.swarm import closure
from backend.apps.swarm.entities.apps import AppExportable


def test_bundle_keys_are_slashes_even_when_the_os_answers_with_backslashes(monkeypatch):
    real_relpath = os.path.relpath
    # The Windows shape: relpath answers with backslashes and the separator is a backslash.
    monkeypatch.setattr(os.path, "relpath", lambda full, start: real_relpath(full, start).replace("/", "\\"))
    monkeypatch.setattr(os, "sep", "\\")
    assert closure.bundle_key("/sb/entities/e1/files/workspace/app/index.html", "/sb/entities/e1/files") == "workspace/app/index.html"


def test_the_staging_reader_uses_the_slash_keys(tmp_path):
    base = tmp_path / "entities" / "e1" / "files" / "workspace" / "app"
    base.mkdir(parents=True)
    (base / "index.html").write_bytes(b"<h1>x</h1>")
    ref = type("Ref", (), {"path": "entities/e1"})()
    assert list(closure.p_read_files(str(tmp_path), ref)) == ["workspace/app/index.html"]
    src = open(closure.__file__).read()
    assert "out[bundle_key(full, base)]" in src


def test_a_bundle_whose_files_miss_the_workspace_prefix_fails_loudly(tmp_path, monkeypatch):
    monkeypatch.setattr("backend.apps.swarm.entities.apps.OUTPUTS_WORKSPACE_DIR", str(tmp_path / "ws"))
    monkeypatch.setattr("backend.apps.swarm.entities.apps.OUTPUTS_DIR", str(tmp_path / "out"))
    with pytest.raises(ValueError, match="nothing was imported"):
        AppExportable.import_({"name": "Hollow"}, {"workspace\\\\app\\\\index.html": b"<h1>x</h1>"}, {})
    assert not (tmp_path / "out").exists() or not list((tmp_path / "out").glob("*.json"))
