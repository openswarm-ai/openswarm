import re

from typeguard import typechecked

# Secret shapes that must never ride along when we ship a stderr tail or an error string to telemetry. own_key mode means the subprocess stderr can echo the user's OWN provider key, so this scrub is the wall between a diagnostic and a key leak; over-redacting is fine, leaking is not.
P_TELEMETRY_SECRET_PATTERNS = (
    re.compile(r"sk-ant-[A-Za-z0-9_\-]{12,}"),
    re.compile(r"sk-[A-Za-z0-9_\-]{16,}"),
    re.compile(r"AIza[A-Za-z0-9_\-]{20,}"),
    re.compile(r"gh[pousr]_[A-Za-z0-9]{20,}"),
    re.compile(r"(?i)bearer\s+[A-Za-z0-9._\-]{12,}"),
    re.compile(r"(?i)\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|authorization)\b[\"']?\s*[:=]\s*[\"']?[A-Za-z0-9._\-]{6,}"),
)


@typechecked
def redact_for_telemetry(text: str, *, limit: int = 2000) -> str:
    """Scrub secret-shaped substrings, then keep the tail (where the real error
    lands), bounded so a runaway log can't bloat the payload. Every raw
    error/stderr string goes through here before it leaves the machine."""
    if not text:
        return ""
    for pat in P_TELEMETRY_SECRET_PATTERNS:
        text = pat.sub("[redacted]", text)
    return text[-limit:]
