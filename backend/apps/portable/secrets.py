"""Secret-stripping helpers for .swarm bundle exports.

Never let a secret leave the machine. Any dict value whose key matches a
known-secret pattern is replaced with the placeholder `${USER_PROVIDED}` and
the key is recorded so the import UI can prompt the user to supply a new
value.
"""

import re
from typing import Any


PLACEHOLDER = "${USER_PROVIDED}"

SECRET_KEY_PATTERNS = [
    re.compile(r".*_?TOKEN$", re.IGNORECASE),
    re.compile(r".*_?KEY$", re.IGNORECASE),
    re.compile(r".*_?SECRET$", re.IGNORECASE),
    re.compile(r".*_?PASSWORD$", re.IGNORECASE),
    re.compile(r".*_?PASS$", re.IGNORECASE),
    re.compile(r".*CREDENTIAL.*", re.IGNORECASE),
    re.compile(r".*AUTH.*", re.IGNORECASE),
    re.compile(r".*API.*KEY.*", re.IGNORECASE),
    re.compile(r".*COOKIE.*", re.IGNORECASE),
]

# Keys that are *always* stripped regardless of pattern match
ALWAYS_STRIP_KEYS = {
    "access_token",
    "refresh_token",
    "id_token",
    "oauth_tokens",
    "client_secret",
}


def is_secret_key(key: str) -> bool:
    if key in ALWAYS_STRIP_KEYS:
        return True
    for pat in SECRET_KEY_PATTERNS:
        if pat.match(key):
            return True
    return False


def strip_dict(d: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    """Recursively replace secret values in *d* with the placeholder.

    Returns (new_dict, list_of_stripped_keys). Nested dicts are descended
    into; non-dict values under secret keys are replaced with the placeholder
    regardless of type.
    """
    stripped_keys: list[str] = []
    out: dict[str, Any] = {}
    for k, v in d.items():
        if is_secret_key(k):
            if v not in (None, "", {}, []):
                stripped_keys.append(k)
                out[k] = PLACEHOLDER
            else:
                out[k] = v
            continue
        if isinstance(v, dict):
            nested, nested_keys = strip_dict(v)
            out[k] = nested
            stripped_keys.extend(nested_keys)
        else:
            out[k] = v
    return out, stripped_keys


def strip_tool_config(tool_dict: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    """Strip secrets from a ToolDefinition dict.

    Targets: credentials, oauth_tokens, and any `env` sub-dict inside
    mcp_config.
    """
    out = dict(tool_dict)
    stripped: list[str] = []

    if "credentials" in out and isinstance(out["credentials"], dict):
        out["credentials"], keys = strip_dict(out["credentials"])
        stripped.extend(keys)

    if "oauth_tokens" in out and isinstance(out["oauth_tokens"], dict):
        # Wipe OAuth tokens completely — they're short-lived and user-specific.
        if out["oauth_tokens"]:
            stripped.append("oauth_tokens")
        out["oauth_tokens"] = {}

    if "connected_account_email" in out:
        out["connected_account_email"] = None

    if "auth_status" in out and out.get("auth_status") == "connected":
        out["auth_status"] = "none"

    mcp = out.get("mcp_config")
    if isinstance(mcp, dict):
        mcp_copy = dict(mcp)
        if "env" in mcp_copy and isinstance(mcp_copy["env"], dict):
            mcp_copy["env"], keys = strip_dict(mcp_copy["env"])
            stripped.extend(keys)
        out["mcp_config"] = mcp_copy

    return out, stripped
