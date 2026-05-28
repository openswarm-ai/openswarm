"""Per-install UUID4 binding in-flight OAuth claims to the install that started them."""

from __future__ import annotations

import os
import uuid

from backend.config.paths import DATA_ROOT

_INSTALL_ID_FILE = os.path.join(DATA_ROOT, "install_id")
_cached: str | None = None


def get_install_id() -> str:
    """Return the persistent install_id, generating and persisting on first call."""
    global _cached
    if _cached:
        return _cached

    try:
        with open(_INSTALL_ID_FILE, "r", encoding="utf-8") as f:
            existing = f.read().strip()
            if _looks_like_uuid(existing):
                _cached = existing
                return _cached
    except FileNotFoundError:
        pass
    except Exception:
        pass

    fresh = str(uuid.uuid4())
    os.makedirs(os.path.dirname(_INSTALL_ID_FILE) or ".", exist_ok=True)
    fd = os.open(_INSTALL_ID_FILE, os.O_CREAT | os.O_WRONLY | os.O_TRUNC, 0o600)
    try:
        os.write(fd, fresh.encode("utf-8"))
    finally:
        os.close(fd)
    _cached = fresh
    return _cached


def _looks_like_uuid(s: str) -> bool:
    if len(s) != 36:
        return False
    try:
        uuid.UUID(s)
        return True
    except ValueError:
        return False
