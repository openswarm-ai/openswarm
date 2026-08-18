"""Which interpreter a generated app's backend venv belongs to.

The backend hands a generated app's `run.sh` its own interpreter (`OPENSWARM_PYTHON`), so a venv is only
reusable when its interpreter *is* that interpreter: same version, implementation, ABI cache tag, platform and
machine. Nothing here pins a version — when the embedded runtime moves, every venv built by the previous one
is recognised as stale by comparison, and the warm cache is keyed by the same identity.
"""
import json
import os
import platform
import stat
import subprocess
import sys
from pathlib import Path


IDENTITY_FIELDS = ("version", "implementation", "cache_tag", "platform", "machine")


def runtime_identity_payload() -> dict[str, str]:
    return {
        "version": ".".join(str(part) for part in sys.version_info[:3]),
        "implementation": sys.implementation.name,
        "cache_tag": sys.implementation.cache_tag or "",
        "platform": sys.platform,
        "machine": platform.machine().lower(),
    }


def runtime_identity_is_valid(identity: object) -> bool:
    return (
        isinstance(identity, dict)
        and set(identity) == set(IDENTITY_FIELDS)
        and all(isinstance(identity[field], str) and bool(identity[field]) for field in IDENTITY_FIELDS)
    )


def current_python_runtime_identity() -> dict[str, str]:
    identity = runtime_identity_payload()
    if not runtime_identity_is_valid(identity):
        raise RuntimeError("the running interpreter does not report a complete runtime identity")
    return identity


def venv_python(venv_dir: str | Path) -> Path:
    root = Path(venv_dir)
    return root / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def configured_venv_version(venv_dir: str | Path) -> str | None:
    config = Path(venv_dir) / "pyvenv.cfg"
    try:
        attributes = getattr(os.lstat(config), "st_file_attributes", 0)
        if config.is_symlink() or attributes & getattr(
            stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0
        ):
            return None
        lines = config.read_text(encoding="utf-8").splitlines()
    except OSError:
        return None
    for line in lines:
        key, separator, value = line.partition("=")
        if separator and key.strip().lower() == "version":
            return value.strip()
    return None


def venv_metadata_is_current(venv_dir: str | Path) -> bool:
    """`pyvenv.cfg` names the version of the interpreter that created the venv; it must be ours."""
    return configured_venv_version(venv_dir) == current_python_runtime_identity()["version"]


def python_runtime_identity(executable: str | Path) -> dict[str, str] | None:
    """Ask an interpreter for its identity; None when it cannot answer or answers incompletely."""
    probe = (
        "import json,platform,sys;"
        "print(json.dumps({"
        "'version':'.'.join(str(x) for x in sys.version_info[:3]),"
        "'implementation':sys.implementation.name,"
        "'cache_tag':sys.implementation.cache_tag or '',"
        "'platform':sys.platform,'machine':platform.machine().lower()"
        "},sort_keys=True,separators=(',',':')))"
    )
    try:
        result = subprocess.run(
            [os.fspath(executable), "-I", "-c", probe],
            capture_output=True,
            text=True,
            timeout=15,
        )
        identity = json.loads(result.stdout) if result.returncode == 0 else None
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError, TypeError):
        return None
    return identity if runtime_identity_is_valid(identity) else None
