#!/usr/bin/env python3
"""Stdlib-only helper for the template's shell scripts: decide whether a `.venv` may be reused, rebuilt or
removed. Run with the interpreter that will run the backend (`OPENSWARM_PYTHON`).

    identity                 print this interpreter's identity as JSON
    verify VENV              0 = owned and built by this interpreter; 20 = owned but stale (rebuild);
                             21 = not ours or redirected — leave it alone
    verify-cache CACHE_ROOT  0 = an OpenSwarm-owned, fully populated warm cache that is safe to copy
    claim-created VENV       mark a venv this interpreter just created as OpenSwarm-owned
    remove-owned VENV        remove a venv only if it is OpenSwarm-owned and not a symlink/junction

A venv is "ours" when it carries the owner marker, or the legacy `.openswarm_installed` sentinel that earlier
template versions wrote after their first install (those are adopted, then judged like any other).
"""
from __future__ import annotations

import json
import os
import platform
import shutil
import stat
import subprocess
import sys
import time
from pathlib import Path


MINIMUM_PYTHON = (3, 10)  # the template backend's own `requires-python`
IDENTITY_FIELDS = ("version", "implementation", "cache_tag", "platform", "machine")
OWNER_MARKER = ".openswarm-venv-owner.json"
CACHE_OWNER_MARKER = ".openswarm-cache-owner.json"
LEGACY_MARKER = ".openswarm_installed"
RUNTIME_METADATA = ".python-runtime.json"
OWNER_PAYLOAD = {"owner": "openswarm", "schema": 1}
EXIT_STALE = 20
EXIT_UNSAFE = 21


def runtime_identity() -> dict[str, str]:
    if sys.version_info < MINIMUM_PYTHON:
        raise RuntimeError("the template backend needs Python %d.%d or newer" % MINIMUM_PYTHON)
    identity = {
        "version": ".".join(str(part) for part in sys.version_info[:3]),
        "implementation": sys.implementation.name,
        "cache_tag": sys.implementation.cache_tag or "",
        "platform": sys.platform,
        "machine": platform.machine().lower(),
    }
    if not identity_is_complete(identity):
        raise RuntimeError("this interpreter does not report a complete runtime identity")
    return identity


def identity_is_complete(value: object) -> bool:
    return (
        isinstance(value, dict)
        and set(value) == set(IDENTITY_FIELDS)
        and all(isinstance(value[field], str) and value[field] for field in IDENTITY_FIELDS)
    )


def path_is_reparse(path: Path) -> bool:
    try:
        if path.is_symlink():
            return True
        is_junction = getattr(path, "is_junction", None)
        if callable(is_junction) and is_junction():
            return True
        attributes = getattr(os.lstat(path), "st_file_attributes", 0)
    except OSError:
        return False
    return bool(attributes & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0))


def assert_normal_directory(path: Path, label: str) -> None:
    if path_is_reparse(path):
        raise RuntimeError(f"{label} is a symlink, junction, or reparse point")
    if not path.is_dir():
        raise RuntimeError(f"{label} is not a directory")


def marker_is_valid(path: Path) -> bool:
    if path_is_reparse(path):
        return False
    try:
        return json.loads(path.read_text(encoding="utf-8")) == OWNER_PAYLOAD
    except (OSError, json.JSONDecodeError, TypeError):
        return False


def write_owner_marker(root: Path) -> None:
    marker = root / OWNER_MARKER
    pending = marker.with_name(f"{marker.name}.pending-{os.getpid()}-{time.time_ns()}")
    pending.write_text(
        json.dumps(OWNER_PAYLOAD, sort_keys=True, separators=(",", ":")) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    os.replace(pending, marker)


def configured_version(root: Path) -> str | None:
    config = root / "pyvenv.cfg"
    try:
        if path_is_reparse(config):
            return None
        lines = config.read_text(encoding="utf-8").splitlines()
    except OSError:
        return None
    for line in lines:
        key, separator, value = line.partition("=")
        if separator and key.strip().lower() == "version":
            return value.strip()
    return None


def venv_python(root: Path) -> Path:
    return root / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def establish_ownership(root: Path, *, allow_legacy: bool) -> None:
    assert_normal_directory(root, "virtual environment")
    if marker_is_valid(root / OWNER_MARKER):
        return
    legacy = root / LEGACY_MARKER
    if allow_legacy and legacy.is_file() and not path_is_reparse(legacy):
        write_owner_marker(root)
        return
    raise RuntimeError("virtual environment is not owned by OpenSwarm")


def claim_created(root: Path) -> None:
    assert_normal_directory(root, "created virtual environment")
    if configured_version(root) != runtime_identity()["version"]:
        raise RuntimeError("created virtual environment does not name this interpreter's version")
    write_owner_marker(root)


def probe_venv(root: Path) -> dict[str, str] | None:
    script = Path(__file__).resolve()
    try:
        result = subprocess.run(
            [os.fspath(venv_python(root)), "-I", os.fspath(script), "identity"],
            capture_output=True,
            text=True,
            timeout=15,
        )
        value = json.loads(result.stdout) if result.returncode == 0 else None
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError, TypeError):
        return None
    return value if value == runtime_identity() else None


def verify_venv(root: Path, *, allow_legacy: bool = True) -> int:
    try:
        establish_ownership(root, allow_legacy=allow_legacy)
    except RuntimeError as exc:
        print(f"unsafe: {exc}", file=sys.stderr)
        return EXIT_UNSAFE
    expected = runtime_identity()
    if configured_version(root) != expected["version"]:
        print(f"stale: pyvenv.cfg was not written by Python {expected['version']}", file=sys.stderr)
        return EXIT_STALE
    if probe_venv(root) is None:
        print("stale: the venv interpreter is not this interpreter", file=sys.stderr)
        return EXIT_STALE
    return 0


def verify_cache(root: Path) -> int:
    """Structural: owned, complete, not redirected. Which interpreter built it is judged by `run.sh`,
    which holds the interpreter that will actually run the backend and re-verifies the copy."""
    try:
        assert_normal_directory(root, "warm-cache root")
        if not marker_is_valid(root / CACHE_OWNER_MARKER):
            raise RuntimeError("warm-cache root is not owned by OpenSwarm")
        sentinel = root / ".populated"
        metadata = root / RUNTIME_METADATA
        if path_is_reparse(sentinel) or path_is_reparse(metadata):
            raise RuntimeError("warm-cache marker or metadata is redirected")
        if sentinel.read_text(encoding="utf-8") != "ok\n":
            raise RuntimeError("warm-cache completion marker is invalid")
        if not identity_is_complete(json.loads(metadata.read_text(encoding="utf-8"))):
            raise RuntimeError("warm-cache runtime metadata is incomplete")
        venv = root / ".venv"
        assert_normal_directory(venv, "warm-cache venv")
        if not marker_is_valid(venv / OWNER_MARKER):
            raise RuntimeError("warm-cache venv is not owned by OpenSwarm")
    except (OSError, json.JSONDecodeError, RuntimeError) as exc:
        print(f"unsafe: {exc}", file=sys.stderr)
        return EXIT_UNSAFE
    return 0


def remove_owned(root: Path) -> None:
    establish_ownership(root, allow_legacy=True)
    shutil.rmtree(root)
    if os.path.lexists(root):
        raise RuntimeError("virtual environment survived recursive removal")


def main(argv: list[str]) -> int:
    if len(argv) == 1 and argv[0] == "identity":
        print(json.dumps(runtime_identity(), sort_keys=True, separators=(",", ":")))
        return 0
    if len(argv) != 2:
        raise RuntimeError("expected identity or COMMAND VENV_PATH")
    command, raw_path = argv
    root = Path(raw_path)
    if command == "claim-created":
        claim_created(root)
        return 0
    if command == "verify":
        return verify_venv(root)
    if command == "verify-cache":
        return verify_cache(root)
    if command == "remove-owned":
        remove_owned(root)
        return 0
    raise RuntimeError(f"unknown command: {command}")


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except Exception as exc:
        print(f"python runtime guard: {exc}", file=sys.stderr)
        raise SystemExit(EXIT_UNSAFE) from None
