"""The shared backend venv for generated apps: keyed by interpreter identity, owned, published atomically,
reused only after its interpreter proves it is ours."""
import json
import os
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

from backend.apps.outputs.python_venv import cache, identity, safety


HOST = identity.runtime_identity_payload()
# Another interpreter: what a venv built by the previous embedded runtime looks like to this one.
OTHER = {**HOST, "version": "3.9.1", "cache_tag": "cpython-39"}


def write_owned_cache(root: Path, runtime: dict[str, str] = HOST) -> Path:
    root.mkdir(parents=True)
    safety.mark_cache_root(root)
    venv = root / ".venv"
    venv.mkdir()
    (venv / "pyvenv.cfg").write_text(f"version = {HOST['version']}\n", encoding="utf-8")
    safety.mark_created_venv(venv)
    (root / ".populated").write_text("ok\n", encoding="utf-8")
    (root / cache.PYTHON_RUNTIME_METADATA).write_text(
        json.dumps(runtime, sort_keys=True) + "\n", encoding="utf-8"
    )
    return venv


def test_warm_venv_key_includes_every_runtime_dimension(monkeypatch, tmp_path):
    monkeypatch.setenv("OPENSWARM_BACKEND_VENV_CACHE_DIR", str(tmp_path))
    template = tmp_path / "template/backend"
    template.mkdir(parents=True)
    (template / "pyproject.toml").write_text("dependencies = []\n", encoding="utf-8")
    monkeypatch.setattr(cache, "WEBAPP_TEMPLATE_DIR", tmp_path / "template")
    keys = set()
    for field in identity.IDENTITY_FIELDS:
        runtime = {**HOST, field: HOST[field] + "-other"}
        monkeypatch.setattr(cache, "current_python_runtime_identity", lambda item=runtime: item)
        keys.add(cache.warm_venv_dir())
    monkeypatch.setattr(cache, "current_python_runtime_identity", lambda: HOST)
    keys.add(cache.warm_venv_dir())
    assert len(keys) == len(identity.IDENTITY_FIELDS) + 1


def test_warm_venv_key_changes_with_template_dependencies(monkeypatch, tmp_path):
    monkeypatch.setenv("OPENSWARM_BACKEND_VENV_CACHE_DIR", str(tmp_path))
    template = tmp_path / "template/backend"
    template.mkdir(parents=True)
    monkeypatch.setattr(cache, "WEBAPP_TEMPLATE_DIR", tmp_path / "template")
    (template / "pyproject.toml").write_text("dependencies = ['a']\n", encoding="utf-8")
    first = cache.warm_venv_dir()
    (template / "pyproject.toml").write_text("dependencies = ['a', 'b']\n", encoding="utf-8")
    assert cache.warm_venv_dir() != first


def test_unreadable_dependency_identity_fails_closed(monkeypatch, tmp_path):
    monkeypatch.setattr(cache, "WEBAPP_TEMPLATE_DIR", tmp_path / "missing")
    with pytest.raises(RuntimeError, match="dependency content"):
        cache.warm_venv_dir()


def test_cache_installs_exactly_the_template_backend_dependencies():
    declared = cache.template_dependencies()
    assert "fastapi[standard]" in declared
    assert any(item.startswith("swarm-debug") for item in declared)
    assert any(item.startswith("typeguard") for item in declared)


def test_malformed_template_dependencies_fail_closed(monkeypatch, tmp_path):
    template = tmp_path / "template/backend"
    template.mkdir(parents=True)
    monkeypatch.setattr(cache, "WEBAPP_TEMPLATE_DIR", tmp_path / "template")
    (template / "pyproject.toml").write_text("[project]\nname = 'x'\n", encoding="utf-8")
    with pytest.raises(RuntimeError, match="dependencies"):
        cache.template_dependencies()
    (template / "pyproject.toml").write_text("[project]\ndependencies = 'fastapi'\n", encoding="utf-8")
    with pytest.raises(RuntimeError, match="requirement strings"):
        cache.template_dependencies()


def test_runtime_identity_is_the_running_interpreter():
    current = identity.current_python_runtime_identity()
    assert current["version"] == ".".join(str(part) for part in sys.version_info[:3])
    assert current["implementation"] == sys.implementation.name
    assert identity.runtime_identity_is_valid(current)
    assert not identity.runtime_identity_is_valid({**current, "machine": ""})
    assert not identity.runtime_identity_is_valid({key: value for key, value in current.items() if key != "platform"})
    assert identity.python_runtime_identity(sys.executable) == current


def test_populated_cache_requires_ownership_before_probe(monkeypatch, tmp_path):
    root = tmp_path / "unowned"
    venv = root / ".venv"
    venv.mkdir(parents=True)
    (venv / "pyvenv.cfg").write_text(f"version = {HOST['version']}\n", encoding="utf-8")
    (root / ".populated").write_text("ok\n", encoding="utf-8")
    (root / cache.PYTHON_RUNTIME_METADATA).write_text(json.dumps(HOST), encoding="utf-8")
    monkeypatch.setattr(
        cache, "python_runtime_identity", lambda path: pytest.fail("unowned interpreter executed")
    )
    assert not cache.warm_python_venv_is_complete(str(root))


def test_stale_pyvenv_cfg_rejected_before_interpreter_probe(monkeypatch, tmp_path):
    root = tmp_path / "stale"
    venv = write_owned_cache(root)
    (venv / "pyvenv.cfg").write_text(f"version = {OTHER['version']}\n", encoding="utf-8")
    monkeypatch.setattr(
        cache, "python_runtime_identity", lambda path: pytest.fail("stale interpreter executed")
    )
    assert not cache.warm_python_venv_is_complete(str(root))


def test_cache_built_by_another_interpreter_is_not_complete(monkeypatch, tmp_path):
    root = tmp_path / "other"
    write_owned_cache(root, OTHER)
    monkeypatch.setattr(
        cache, "python_runtime_identity", lambda path: pytest.fail("foreign interpreter executed")
    )
    assert not cache.warm_python_venv_is_complete(str(root))


def test_complete_cache_is_recognised_only_after_its_interpreter_answers(monkeypatch, tmp_path):
    root = tmp_path / "complete"
    write_owned_cache(root)
    monkeypatch.setattr(cache, "python_runtime_identity", lambda path: OTHER)
    assert not cache.warm_python_venv_is_complete(str(root))
    monkeypatch.setattr(cache, "python_runtime_identity", lambda path: dict(HOST))
    assert cache.warm_python_venv_is_complete(str(root))


def test_previous_layout_cache_is_neither_reused_nor_adopted(monkeypatch, tmp_path):
    """The layout before this change (a `.populated` sentinel, no runtime metadata, no owner markers) is
    not complete, its interpreter is never run, and nothing is written into it."""
    root = tmp_path / "old"
    venv = root / ".venv"
    venv.mkdir(parents=True)
    (venv / "pyvenv.cfg").write_text(f"version = {HOST['version']}\n", encoding="utf-8")
    (root / ".populated").write_text("ok\n", encoding="utf-8")
    monkeypatch.setattr(
        cache, "python_runtime_identity", lambda path: pytest.fail("old-layout interpreter executed")
    )

    assert not cache.warm_python_venv_is_complete(str(root))
    assert sorted(item.name for item in root.iterdir()) == [".populated", ".venv"]
    assert sorted(item.name for item in venv.iterdir()) == ["pyvenv.cfg"]


def test_atomic_publication_replaces_only_owned_cache(tmp_path):
    final = tmp_path / "cache"
    old_venv = write_owned_cache(final)
    (old_venv / "old.txt").write_text("old", encoding="utf-8")
    staging = tmp_path / "cache.staging"
    new_venv = write_owned_cache(staging)
    (new_venv / "new.txt").write_text("new", encoding="utf-8")

    cache.publish_staging(staging, final)

    assert (final / ".venv/new.txt").read_text(encoding="utf-8") == "new"
    assert not staging.exists()
    assert not list(tmp_path.glob("*.retired-*"))


def test_publication_refuses_to_replace_an_unowned_directory(tmp_path):
    final = tmp_path / "cache"
    (final / ".venv").mkdir(parents=True)
    (final / ".venv/keep.txt").write_text("keep", encoding="utf-8")
    staging = tmp_path / "cache.staging"
    write_owned_cache(staging)

    with pytest.raises(RuntimeError, match="not owned"):
        cache.publish_staging(staging, final)

    assert (final / ".venv/keep.txt").read_text(encoding="utf-8") == "keep"
    assert staging.is_dir()


def test_failed_publication_restores_previous_cache(monkeypatch, tmp_path):
    final = tmp_path / "cache"
    old_venv = write_owned_cache(final)
    (old_venv / "old.txt").write_text("old", encoding="utf-8")
    staging = tmp_path / "cache.staging"
    write_owned_cache(staging)
    real_replace = os.replace

    def fail_staging_publish(source, destination):
        if Path(source) == staging and Path(destination) == final:
            raise OSError("injected publish failure")
        return real_replace(source, destination)

    monkeypatch.setattr(cache.os, "replace", fail_staging_publish)

    with pytest.raises(OSError, match="injected publish failure"):
        cache.publish_staging(staging, final)

    assert (final / ".venv/old.txt").read_text(encoding="utf-8") == "old"
    assert staging.is_dir()
    assert not list(tmp_path.glob("*.retired-*"))


def test_failed_warm_cache_build_removes_owned_staging(monkeypatch, tmp_path):
    final = tmp_path / "cache"
    monkeypatch.setattr(cache, "warm_venv_dir", lambda: str(final))

    def fail_after_claiming(staging, python):
        staging.mkdir()
        safety.mark_cache_root(staging)
        raise RuntimeError("injected build failure")

    monkeypatch.setattr(cache, "p_build_staging_cache", fail_after_claiming)

    assert cache.ensure_warm_python_venv() is None
    assert not final.exists()
    assert not list(tmp_path.glob("*.staging-*"))


def test_remove_owned_tree_refuses_unmarked_directories(tmp_path):
    victim = tmp_path / "not-ours"
    victim.mkdir()
    (victim / "file").write_text("x", encoding="utf-8")
    with pytest.raises(RuntimeError, match="refusing to remove"):
        safety.remove_owned_tree(victim, marker_name=safety.CACHE_OWNER_MARKER)
    assert (victim / "file").exists()


@pytest.mark.skipif(os.name == "nt", reason="POSIX symlink behaviour")
def test_owned_venv_behind_a_symlink_is_not_ours(tmp_path):
    real = tmp_path / "real"
    real.mkdir()
    (real / "pyvenv.cfg").write_text(f"version = {HOST['version']}\n", encoding="utf-8")
    safety.mark_created_venv(real)
    link = tmp_path / "link"
    link.symlink_to(real, target_is_directory=True)
    with pytest.raises(RuntimeError, match="symlink"):
        safety.assert_owned_venv(link)


def test_process_lock_serializes_concurrent_cache_creators(tmp_path):
    lock = tmp_path / "cache lock.lock"
    winner = tmp_path / "winner.txt"
    code = textwrap.dedent(
        """
        import pathlib,sys,time
        from backend.apps.outputs.python_venv.safety import process_lock
        lock,winner = map(pathlib.Path, sys.argv[1:])
        with process_lock(lock, timeout=10):
            if winner.exists():
                print('reuse')
            else:
                time.sleep(0.3)
                winner.write_text(str(__import__('os').getpid()), encoding='utf-8')
                print('build')
        """
    )
    env = {**os.environ, "PYTHONPATH": str(Path(__file__).resolve().parents[2])}
    processes = [
        subprocess.Popen(
            [sys.executable, "-c", code, str(lock), str(winner)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=env,
        )
        for _ in range(2)
    ]
    outputs = [process.communicate(timeout=15) for process in processes]
    assert all(process.returncode == 0 for process in processes), outputs
    assert sorted(stdout.strip() for stdout, _ in outputs) == ["build", "reuse"]
