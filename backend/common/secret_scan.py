"""Shared secret-shape scanner: spot credential-shaped literals in text/files.

Lives in backend.common so the .swarm importer, the skills registry, and the
settings redactor all pull it DOWN from one place instead of one feature app
reaching sideways into another. It catches a secret by its SHAPE (sk-ant-...,
ghp_..., AIza...), which is the fail-safe behind name-based redaction: a key
that's misnamed (so a name rule misses it) still gets caught by its shape."""

from __future__ import annotations

import re

REDACTED = "[redacted]"

# Literal-secret shapes someone might paste into a file, skill body, or setting.
SECRET_SHAPE_PATTERNS = (
    re.compile(r"sk-ant-[A-Za-z0-9_\-]{16,}"),
    re.compile(r"sk-[A-Za-z0-9_\-]{16,}"),
    re.compile(r"AIza[A-Za-z0-9_\-]{20,}"),          # Google API key shape
    re.compile(r"gh[pousr]_[A-Za-z0-9]{20,}"),       # GitHub tokens
    re.compile(r"Bearer\s+[A-Za-z0-9._\-]{16,}"),
)


def looks_secret(text: str) -> bool:
    """True if `text` contains a credential-shaped literal."""
    return any(p.search(text) for p in SECRET_SHAPE_PATTERNS)


def redact_secret_shapes(text: str) -> str:
    """Replace every secret-shaped literal in `text` with the redacted marker."""
    for p in SECRET_SHAPE_PATTERNS:
        text = p.sub(REDACTED, text)
    return text


def find_secrets_in_files(files: dict[str, bytes]) -> list[str]:
    """Paths of any file whose text body holds a secret-shaped literal. Binary
    files (a null byte in the first 4KB) are skipped, they aren't pasted text."""
    hits: list[str] = []
    for path, data in files.items():
        if b"\x00" in data[:4096]:
            continue
        if looks_secret(data.decode("utf-8", errors="ignore")):
            hits.append(path)
    return hits
