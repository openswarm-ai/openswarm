"""Importing settings must never pay the OS temp-dir toll (ENG-312, measured on Eric's machine).

cProfile of `import backend.apps.settings.settings` on the packaged python attributed 6.0 of 6.6
seconds to two module-level lines: `tempfile.gettempdir()` (2.9s, it PROBES the temp dir with a
create+unlink) and `os.makedirs(UPLOAD_DIR)` (3.1s of stats), because that temp dir has grown to
unlistable size (a bare listdir times out at 10s; the same monster that killed dictation). Uploads
now live under DATA_ROOT, created lazily on first use, and the GC loop sweeps the legacy location.
"""
import ast
import os

from backend.apps.settings.settings import legacy_upload_dir


def test_no_module_level_tempdir_or_makedirs():
    import backend.apps.settings.settings as mod

    src = open(mod.__file__).read()
    tree = ast.parse(src)
    offenders = []
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            continue
        for sub in ast.walk(node):
            if isinstance(sub, ast.Call):
                target = ast.unparse(sub.func)
                if "gettempdir" in target or "makedirs" in target:
                    offenders.append((node.lineno, target))
    assert not offenders, f"import-time temp-dir toll is back: {offenders}"


def test_upload_dir_lives_under_data_root_and_creates_itself(tmp_path, monkeypatch):
    import backend.apps.settings.settings as mod

    monkeypatch.setattr("backend.config.paths.DATA_ROOT", str(tmp_path))
    d = mod.upload_dir()
    assert d.startswith(str(tmp_path)), "uploads must live in OUR dir, never the OS temp dir"
    assert os.path.isdir(d), "first use creates it"


def test_legacy_location_is_still_named_for_the_gc_sweep():
    # The old temp-dir location keeps getting swept so past uploads do not sit there for 7 years.
    assert legacy_upload_dir().endswith("self-swarm-uploads")
