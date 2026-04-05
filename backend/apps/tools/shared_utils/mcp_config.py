"""PATH resolution and command lookup helpers for MCP stdio servers.

These are needed because packaged Electron apps and various Node version
managers (nvm, fnm, volta) install binaries in non-standard locations that
may not be on the default PATH.
"""

import os
import shutil
from typing import List, Optional

# TODO: either remove the import, or make it a non private var
from backend.config.paths import P_BACKEND_DIR
from typeguard import typechecked

P_UV_BIN_DIR = os.path.join(P_BACKEND_DIR, "uv-bin")

@typechecked
def p_extra_bin_dirs() -> list[str]:
    """Well-known user-local bin directories that may not be on PATH in packaged apps."""
    home = os.path.expanduser("~")
    dirs: List[str] = [
        P_UV_BIN_DIR,
        os.path.join(home, ".bun", "bin"),
        os.path.join(home, ".cargo", "bin"),
        os.path.join(home, ".local", "bin"),
        os.path.join(home, ".volta", "bin"),
        "/opt/homebrew/bin",
        "/usr/local/bin",
    ]
    nvm_node = os.path.join(home, ".nvm", "versions", "node")
    try:
        if os.path.isdir(nvm_node):
            versions = sorted(os.listdir(nvm_node), reverse=True)
            if versions:
                dirs.insert(0, os.path.join(nvm_node, versions[0], "bin"))
    except OSError:
        pass
    fnm_bin = os.path.join(home, "Library", "Application Support", "fnm", "aliases", "default", "bin")
    if os.path.isdir(fnm_bin):
        dirs.insert(0, fnm_bin)
    return dirs


@typechecked
def resolve_command(command: str) -> Optional[str]:
    """Find an executable on PATH or well-known bin directories."""
    found = shutil.which(command)
    if found:
        return found
    for d in p_extra_bin_dirs():
        candidate = os.path.join(d, command)
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return None


@typechecked
def augmented_path() -> str:
    """Build a PATH string that includes well-known extra bin dirs."""
    extra = [d for d in p_extra_bin_dirs() if os.path.isdir(d)]
    current = os.environ.get("PATH", "")
    seen: set[str] = set[str]()
    parts: list[str] = []
    for p in extra + current.split(os.pathsep):
        if p and p not in seen:
            seen.add(p)
            parts.append(p)
    return os.pathsep.join(parts)
