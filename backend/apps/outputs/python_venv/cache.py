"""The shared warm venv for generated apps' backends: FastAPI and the template's other dependencies
pre-installed once per (template dependencies, interpreter identity), copied into a workspace by
`backend_init.sh` instead of paying `python -m venv` + `pip install` per app.

Every cache directory is owned (marker files), built in a staging directory and published atomically, and
only ever reused after its interpreter proves it is the interpreter this backend runs on.
"""
import hashlib
import json
import logging
import os
import subprocess
import sys
import threading
import tomllib
import uuid
from pathlib import Path

from backend.apps.outputs.python_venv.identity import (
    current_python_runtime_identity,
    python_runtime_identity,
    venv_metadata_is_current,
    venv_python,
)
from backend.apps.outputs.python_venv.safety import (
    CACHE_OWNER_MARKER,
    assert_owned_cache_root,
    assert_owned_venv,
    mark_cache_root,
    mark_created_venv,
    path_exists,
    path_is_reparse,
    process_lock,
    remove_owned_tree,
)


logger = logging.getLogger(__name__)
PYTHON_RUNTIME_METADATA = ".python-runtime.json"
CACHE_SCHEMA = "warm-venv-v2"
WEBAPP_TEMPLATE_DIR = Path(__file__).resolve().parents[1] / "webapp_template"
p_thread_lock = threading.Lock()


def p_dependency_content() -> bytes:
    try:
        return (WEBAPP_TEMPLATE_DIR / "backend/pyproject.toml").read_bytes()
    except OSError as exc:
        raise RuntimeError("cannot identify warm-cache dependency content") from exc


def template_dependencies() -> list[str]:
    """The template backend's declared dependencies — the cache installs exactly these, so the list
    can never drift from `webapp_template/backend/pyproject.toml`."""
    try:
        declared = tomllib.loads(p_dependency_content().decode("utf-8"))["project"]["dependencies"]
    except (KeyError, TypeError, UnicodeDecodeError, tomllib.TOMLDecodeError) as exc:
        raise RuntimeError("cannot read the template backend's dependencies") from exc
    if not isinstance(declared, list) or not all(isinstance(item, str) and item for item in declared):
        raise RuntimeError("the template backend's dependencies are not a list of requirement strings")
    return list(declared)


def warm_venv_dir() -> str:
    identity = json.dumps(
        current_python_runtime_identity(), sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    payload = b"\0".join((CACHE_SCHEMA.encode(), p_dependency_content(), identity))
    digest = hashlib.sha256(payload).hexdigest()[:12]
    base = os.environ.get("OPENSWARM_BACKEND_VENV_CACHE_DIR") or os.path.expanduser(
        "~/.openswarm/cache/webapp_template_backend_venv"
    )
    return os.path.join(base, digest)


def p_read_text(path: Path) -> str | None:
    if path_is_reparse(path):
        return None
    try:
        return path.read_text(encoding="utf-8")
    except OSError:
        return None


def p_recorded_identity(cache_dir: Path) -> dict[str, str] | None:
    metadata = cache_dir / PYTHON_RUNTIME_METADATA
    if path_is_reparse(metadata):
        return None
    try:
        value = json.loads(metadata.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, TypeError):
        return None
    return value if isinstance(value, dict) else None


def warm_python_venv_is_complete(cache_dir: str) -> bool:
    root = Path(cache_dir)
    try:
        assert_owned_cache_root(root)
        venv_dir = assert_owned_venv(root / ".venv")
        expected = current_python_runtime_identity()
        if p_read_text(root / ".populated") != "ok\n":
            return False
        if p_recorded_identity(root) != expected:
            return False
        if not venv_metadata_is_current(venv_dir):
            return False
        return python_runtime_identity(venv_python(venv_dir)) == expected
    except RuntimeError:
        return False


def p_write_atomic(path: Path, content: str) -> None:
    pending = path.with_name(f"{path.name}.pending-{os.getpid()}-{time_token()}")
    pending.write_text(content, encoding="utf-8", newline="\n")
    os.replace(pending, path)


def time_token() -> str:
    return uuid.uuid4().hex


def p_build_staging_cache(staging: Path, python: str) -> None:
    staging.mkdir(parents=False)
    mark_cache_root(staging)
    venv_dir = staging / ".venv"
    result = subprocess.run(
        [python, "-m", "venv", os.fspath(venv_dir)],
        capture_output=True,
        text=True,
        timeout=120,
    )
    if result.returncode != 0:
        raise RuntimeError(f"warm-venv create failed: {result.stderr[-1500:]}")
    mark_created_venv(venv_dir)
    expected = current_python_runtime_identity()
    if python_runtime_identity(venv_python(venv_dir)) != expected:
        raise RuntimeError("created warm-venv interpreter identity is invalid")
    pip = venv_dir / ("Scripts/pip.exe" if os.name == "nt" else "bin/pip")
    result = subprocess.run(
        [os.fspath(pip), "install", "--disable-pip-version-check", *template_dependencies()],
        capture_output=True,
        text=True,
        timeout=600,
    )
    if result.returncode != 0:
        raise RuntimeError(f"warm-venv pip install failed: {result.stderr[-1500:]}")
    if python_runtime_identity(venv_python(venv_dir)) != expected:
        raise RuntimeError("installed warm-venv interpreter identity is invalid")
    metadata = json.dumps(expected, sort_keys=True, separators=(",", ":")) + "\n"
    p_write_atomic(staging / PYTHON_RUNTIME_METADATA, metadata)
    p_write_atomic(staging / ".populated", "ok\n")


def publish_staging(staging: Path, cache_dir: Path) -> None:
    retired: Path | None = None
    if path_exists(cache_dir):
        assert_owned_cache_root(cache_dir)
        retired = cache_dir.with_name(f"{cache_dir.name}.retired-{time_token()}")
        os.replace(cache_dir, retired)
    try:
        os.replace(staging, cache_dir)
    except Exception:
        if retired is not None and not path_exists(cache_dir):
            os.replace(retired, cache_dir)
        raise
    if retired is not None:
        remove_owned_tree(retired, marker_name=CACHE_OWNER_MARKER)


def ensure_warm_python_venv() -> str | None:
    cache_dir = Path(warm_venv_dir())
    venv_dir = cache_dir / ".venv"
    if warm_python_venv_is_complete(os.fspath(cache_dir)):
        return os.fspath(venv_dir)
    lock_path = cache_dir.with_suffix(".lock")
    with p_thread_lock, process_lock(lock_path):
        if warm_python_venv_is_complete(os.fspath(cache_dir)):
            return os.fspath(venv_dir)
        cache_dir.parent.mkdir(parents=True, exist_ok=True)
        staging = cache_dir.with_name(f"{cache_dir.name}.staging-{time_token()}")
        try:
            p_build_staging_cache(staging, sys.executable)
            if not warm_python_venv_is_complete(os.fspath(staging)):
                raise RuntimeError("staging warm cache failed final validation")
            publish_staging(staging, cache_dir)
            logger.info("webapp-template: warm backend venv ready at %s", venv_dir)
            return os.fspath(venv_dir)
        except Exception as exc:
            logger.warning("warm python venv failed: %s", exc)
            return None
        finally:
            if path_exists(staging):
                remove_owned_tree(staging, marker_name=CACHE_OWNER_MARKER)
