"""The template's python_runtime_guard.py and the two shell scripts that call it: a generated app's `.venv`
is reused only when it is ours and was built by the interpreter that will run it, rebuilt when it was built
by another interpreter (the app's Python moved), and left untouched when it is not ours."""
import importlib.util
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[2]
TEMPLATE_BACKEND = ROOT / "backend/apps/outputs/webapp_template/backend"
GUARD_PATH = TEMPLATE_BACKEND / "config/python_runtime_guard.py"
SPEC = importlib.util.spec_from_file_location("generated_python_runtime_guard", GUARD_PATH)
assert SPEC and SPEC.loader
guard = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(guard)

HOST_VERSION = ".".join(str(part) for part in sys.version_info[:3])
OTHER_VERSION = "3.9.1"


def make_fake_venv(root: Path, version: str = HOST_VERSION) -> None:
    root.mkdir(parents=True)
    (root / "pyvenv.cfg").write_text(f"version = {version}\n", encoding="utf-8")


def find_bash() -> str | None:
    git_bash = Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "Git/bin/bash.exe"
    return os.fspath(git_bash) if git_bash.is_file() else shutil.which("bash")


def test_identity_is_this_interpreter():
    identity = guard.runtime_identity()
    assert identity["version"] == HOST_VERSION
    assert identity["implementation"] == sys.implementation.name
    result = subprocess.run(
        [sys.executable, "-I", str(GUARD_PATH), "identity"], capture_output=True, text=True, timeout=30
    )
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == identity


def test_missing_ownership_never_executes_interpreter(monkeypatch, tmp_path):
    venv = tmp_path / "unowned"
    make_fake_venv(venv)
    monkeypatch.setattr(guard, "probe_venv", lambda root: pytest.fail("probe executed"))
    assert guard.verify_venv(venv) == guard.EXIT_UNSAFE
    assert venv.exists()
    assert not (venv / guard.OWNER_MARKER).exists()


def test_stale_legacy_venv_is_adopted_and_judged_stale_without_running_it(monkeypatch, tmp_path):
    """A venv the previous template wrote (sentinel, no marker) under an older Python: ours, stale."""
    venv = tmp_path / "legacy"
    make_fake_venv(venv, OTHER_VERSION)
    (venv / guard.LEGACY_MARKER).write_text("", encoding="utf-8")
    monkeypatch.setattr(guard, "probe_venv", lambda root: pytest.fail("probe executed"))
    assert guard.verify_venv(venv) == guard.EXIT_STALE
    assert (venv / guard.OWNER_MARKER).is_file()


def test_owned_venv_whose_interpreter_answers_differently_is_stale(monkeypatch, tmp_path):
    venv = tmp_path / "owned"
    make_fake_venv(venv)
    guard.write_owner_marker(venv)
    monkeypatch.setattr(guard, "probe_venv", lambda root: None)
    assert guard.verify_venv(venv) == guard.EXIT_STALE
    monkeypatch.setattr(guard, "probe_venv", lambda root: guard.runtime_identity())
    assert guard.verify_venv(venv) == 0


def test_failed_removal_is_a_hard_failure(monkeypatch, tmp_path):
    venv = tmp_path / "owned"
    make_fake_venv(venv)
    guard.write_owner_marker(venv)
    monkeypatch.setattr(guard.shutil, "rmtree", lambda path: None)
    with pytest.raises(RuntimeError, match="survived recursive removal"):
        guard.remove_owned(venv)


def test_remove_owned_refuses_an_unowned_venv(tmp_path):
    venv = tmp_path / "unowned"
    make_fake_venv(venv)
    with pytest.raises(RuntimeError, match="not owned"):
        guard.remove_owned(venv)
    assert venv.is_dir()


def test_verify_cache_is_structural(tmp_path):
    root = tmp_path / "cache"
    venv = root / ".venv"
    make_fake_venv(venv)
    assert guard.verify_cache(root) == guard.EXIT_UNSAFE
    (root / guard.CACHE_OWNER_MARKER).write_text(json.dumps(guard.OWNER_PAYLOAD), encoding="utf-8")
    (root / ".populated").write_text("ok\n", encoding="utf-8")
    (root / guard.RUNTIME_METADATA).write_text(json.dumps({"version": OTHER_VERSION}), encoding="utf-8")
    assert guard.verify_cache(root) == guard.EXIT_UNSAFE  # metadata incomplete
    other = dict(guard.runtime_identity(), version=OTHER_VERSION)
    (root / guard.RUNTIME_METADATA).write_text(json.dumps(other), encoding="utf-8")
    assert guard.verify_cache(root) == guard.EXIT_UNSAFE  # venv not owned
    guard.write_owner_marker(venv)
    # Complete and owned: copyable — even though it was built by another interpreter; run.sh judges that.
    assert guard.verify_cache(root) == 0
    (root / ".populated").write_text("partial\n", encoding="utf-8")
    assert guard.verify_cache(root) == guard.EXIT_UNSAFE


@pytest.mark.skipif(not Path("/usr/bin/python3").exists(), reason="exercises the OS-provided python3")
def test_verify_cache_runs_under_the_system_python(tmp_path):
    """backend_init.sh may only have the OS python (macOS ships 3.9); the structural cache check must work
    there even though that interpreter is too old to run a generated backend."""
    root = tmp_path / "cache"
    venv = root / ".venv"
    make_fake_venv(venv)
    (root / guard.CACHE_OWNER_MARKER).write_text(json.dumps(guard.OWNER_PAYLOAD), encoding="utf-8")
    (root / ".populated").write_text("ok\n", encoding="utf-8")
    (root / guard.RUNTIME_METADATA).write_text(json.dumps(guard.runtime_identity()), encoding="utf-8")
    guard.write_owner_marker(venv)
    result = subprocess.run(
        ["/usr/bin/python3", "-I", str(GUARD_PATH), "verify-cache", str(root)], capture_output=True, text=True, timeout=30
    )
    assert result.returncode == 0, result.stderr
    result = subprocess.run(
        ["/usr/bin/python3", "-I", str(GUARD_PATH), "verify-cache", str(tmp_path)], capture_output=True, text=True, timeout=30
    )
    assert result.returncode == guard.EXIT_UNSAFE


def test_guard_cli_on_a_real_venv_in_a_path_with_spaces(tmp_path):
    venv = tmp_path / "generated app" / "backend env"
    subprocess.run([sys.executable, "-m", "venv", "--without-pip", str(venv)], check=True, timeout=120)

    def run(command: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, "-I", str(GUARD_PATH), command, str(venv)],
            capture_output=True,
            text=True,
            timeout=60,
        )

    unowned = run("verify")
    assert unowned.returncode == guard.EXIT_UNSAFE, unowned.stderr
    assert run("claim-created").returncode == 0
    owned = run("verify")
    assert owned.returncode == 0, owned.stderr
    # The app's Python moved: pyvenv.cfg names another interpreter → stale, and removable.
    config = venv / "pyvenv.cfg"
    config.write_text(config.read_text(encoding="utf-8").replace(HOST_VERSION, OTHER_VERSION), encoding="utf-8")
    stale = run("verify")
    assert stale.returncode == guard.EXIT_STALE, stale.stderr
    assert run("remove-owned").returncode == 0
    assert not venv.exists()


@pytest.mark.skipif(os.name == "nt", reason="POSIX symlink behavior")
def test_posix_symlink_venv_is_preserved(tmp_path):
    target = tmp_path / "outside"
    make_fake_venv(target)
    guard.write_owner_marker(target)
    link = tmp_path / "workspace-venv"
    link.symlink_to(target, target_is_directory=True)
    assert guard.verify_venv(link) == guard.EXIT_UNSAFE
    with pytest.raises(RuntimeError, match="symlink"):
        guard.remove_owned(link)
    assert target.exists()


@pytest.mark.skipif(os.name != "nt", reason="Windows junction behavior")
def test_windows_junction_venv_is_preserved(tmp_path):
    target = tmp_path / "outside"
    make_fake_venv(target)
    junction = tmp_path / "workspace-venv"
    result = subprocess.run(
        ["cmd", "/c", "mklink", "/J", str(junction), str(target)],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        pytest.skip(f"junction creation unavailable: {result.stderr}")
    try:
        assert guard.verify_venv(junction) == guard.EXIT_UNSAFE
        assert target.exists()
    finally:
        os.rmdir(junction)


def run_template_backend(workspace_backend: Path, bash: str) -> subprocess.CompletedProcess:
    # A dead package index makes the (expected) dependency install fail fast instead of reaching PyPI.
    return subprocess.run(
        [bash, os.fspath(workspace_backend / "run.sh")],
        capture_output=True,
        text=True,
        timeout=180,
        env={
            **os.environ,
            "BACKEND_PORT": "8324",
            "OPENSWARM_PYTHON": sys.executable,
            "PIP_INDEX_URL": "http://127.0.0.1:9/simple",
            "PIP_RETRIES": "0",
            "PIP_TIMEOUT": "1",
            "PIP_NO_INPUT": "1",
        },
    )


def test_generated_run_script_preserves_unowned_venv_in_path_with_spaces(tmp_path):
    backend = tmp_path / "generated app with spaces" / "backend"
    shutil.copytree(TEMPLATE_BACKEND, backend)
    venv = backend / ".venv"
    make_fake_venv(venv)
    (venv / "user-file.txt").write_text("mine", encoding="utf-8")
    bash = find_bash()
    if not bash:
        pytest.skip("Git Bash or bash is unavailable")
    result = run_template_backend(backend, bash)
    assert result.returncode != 0
    assert "preserving it for manual remediation" in result.stdout
    assert (venv / "user-file.txt").read_text(encoding="utf-8") == "mine"


def test_generated_run_script_rebuilds_a_venv_built_by_another_python(tmp_path):
    """The upgrade path: a venv the previous template version created (its sentinel is present) under the
    previous interpreter is discarded and rebuilt by the current one — nothing else in the workspace moves."""
    backend = tmp_path / "generated app" / "backend"
    shutil.copytree(TEMPLATE_BACKEND, backend)
    venv = backend / ".venv"
    make_fake_venv(venv, OTHER_VERSION)
    (venv / ".openswarm_installed").write_text("", encoding="utf-8")
    (venv / "stale-site-package.txt").write_text("old", encoding="utf-8")
    (backend / "user-note.txt").write_text("keep", encoding="utf-8")
    bash = find_bash()
    if not bash:
        pytest.skip("Git Bash or bash is unavailable")
    result = run_template_backend(backend, bash)
    assert "Discarding the OpenSwarm-generated virtual environment" in result.stdout, result.stdout
    assert "Creating virtual environment..." in result.stdout
    assert not (venv / "stale-site-package.txt").exists()
    assert (backend / "user-note.txt").read_text(encoding="utf-8") == "keep"
    assert guard.marker_is_valid(venv / guard.OWNER_MARKER)
    assert guard.configured_version(venv) == HOST_VERSION
    # The rebuilt venv reached the dependency install (which this test makes fail on purpose).
    assert "Installing dependencies..." in result.stdout
    assert result.returncode != 0
    assert not (venv / ".openswarm_installed").exists()


@pytest.mark.skipif(os.name == "nt", reason="uses a bash wrapper as OPENSWARM_PYTHON")
def test_generated_run_script_removes_what_a_failed_venv_creation_left_behind(tmp_path):
    """`python -m venv` writes pyvenv.cfg first and can still fail (a runtime without ensurepip, a full
    disk): the half-built .venv is ours, so it is claimed and removed and the next start retries."""
    bash = find_bash()
    if not bash:
        pytest.skip("bash is unavailable")
    backend = tmp_path / "generated app" / "backend"
    shutil.copytree(TEMPLATE_BACKEND, backend)
    wrapper = tmp_path / "python-without-ensurepip"
    wrapper.write_text(
        "#!/bin/bash\n"
        'if [[ "$1" == "-m" && "$2" == "venv" ]]; then\n'
        '  mkdir -p "$3" && printf "version = %s\\n" "' + HOST_VERSION + '" > "$3/pyvenv.cfg"\n'
        '  echo "simulated: ensurepip is unavailable" >&2; exit 1\n'
        "fi\n"
        'exec "' + sys.executable + '" "$@"\n',
        encoding="utf-8",
    )
    wrapper.chmod(0o755)
    result = subprocess.run(
        [bash, os.fspath(backend / "run.sh")],
        capture_output=True,
        text=True,
        timeout=120,
        env={**os.environ, "BACKEND_PORT": "8324", "OPENSWARM_PYTHON": os.fspath(wrapper)},
    )
    assert result.returncode != 0
    assert "Failed to create virtual environment" in result.stdout, result.stdout + result.stderr
    assert not (backend / ".venv").exists()


def test_template_scripts_never_delete_or_reuse_unverified_directories():
    run_script = (TEMPLATE_BACKEND / "run.sh").read_text(encoding="utf-8")
    backend_init = (TEMPLATE_BACKEND.parent / "backend_init.sh").read_text(encoding="utf-8")
    assert "rm -rf" not in run_script
    assert 'remove-owned "$VENV_DIR"' in run_script
    assert 'verify "$VENV_DIR"' in run_script
    assert 'claim-created "$VENV_DIR"' in run_script
    assert 'verify-cache "$CACHE_ROOT"' in backend_init
    assert 'mktemp -d "$HERE/backend/.venv.pending.XXXXXX"' in backend_init
    assert 'cp -aR "$CACHE_VENV"/. "$STAGED_VENV"/' in backend_init
    assert 'cp -aR "$CACHE_VENV" ./backend/.venv' not in backend_init
    assert 'PORT="$("$INIT_PY" -I -c' in backend_init
    assert 'PORT="$(python3 -c' not in backend_init
