"""Redact secrets out of a settings view before an agent ever sees it.

The settings-meta read tool is always-on, so an always-on exfiltration risk: a
prompt-injected agent that could read raw settings could mail your API keys out.
So the read tool returns shape + state, never a secret VALUE. Keys are write-only
from the agent's side: it can SET a new one, never SEE the old.

The secret set is derived from field NAMES, not a hand-kept list that silently
drifts the day someone adds a new credential. Rule: a field whose name ends in
`_key`, `_token`, or `_secret` is a secret, plus installation_id (a stable
machine fingerprint that isn't a credential but still shouldn't leak). A test
asserts every field the settings PUT path already treats as secret is caught
here, so the two can't diverge.
"""

from __future__ import annotations

from typing import Any

from backend.common.secret_scan import looks_secret

P_SECRET_NAME_SUFFIXES = ("_key", "_token", "_secret")
# Not a credential and doesn't match the suffix rule, but a stable hardware-ish
# fingerprint used for cohorting/abuse; keep it out of the agent's eyes too.
P_SECRET_EXTRA_FIELDS = frozenset({"installation_id"})


def is_secret_field(name: str) -> bool:
    return name.endswith(P_SECRET_NAME_SUFFIXES) or name in P_SECRET_EXTRA_FIELDS


def p_value_is_secret_shaped(value: Any) -> bool:
    """Fail-safe behind the name rule: a field the name rule misses (a future
    secret with an off-convention name) is still caught if its VALUE looks like
    a credential (sk-..., ghp_..., Bearer ...). So a leak needs BOTH a bad name
    AND a non-credential-shaped value, not just one."""
    return isinstance(value, str) and looks_secret(value)


def p_redact_value(value: Any) -> dict[str, Any]:
    """A secret rendered as state, never content: configured + last 4 only."""
    if value is None or (isinstance(value, str) and value.strip() == ""):
        return {"configured": False}
    last4 = value[-4:] if isinstance(value, str) and len(value) >= 4 else None
    return {"configured": True, "last4": last4}


def redact_settings(raw: dict[str, Any]) -> dict[str, Any]:
    """Return a copy of a settings dict with every secret value collapsed to
    {configured, last4}. Nested custom-provider api_keys are redacted too."""
    out: dict[str, Any] = {}
    for key, value in raw.items():
        if is_secret_field(key) or p_value_is_secret_shaped(value):
            out[key] = p_redact_value(value)
        elif key == "custom_providers" and isinstance(value, list):
            out[key] = [p_redact_custom_provider(cp) for cp in value]
        else:
            out[key] = value
    return out


def p_redact_custom_provider(cp: Any) -> Any:
    if not isinstance(cp, dict):
        return cp
    out = dict(cp)
    if "api_key" in out:
        out["api_key"] = p_redact_value(out.get("api_key"))
    return out
