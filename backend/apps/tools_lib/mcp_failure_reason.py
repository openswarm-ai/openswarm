"""Turning an MCP server's dying breath into a sentence the user can act on.

When a stdio MCP server exits during discovery we have its stderr, and we used to hand the raw
tail straight to the UI. For a Go server that means a JSON log line with a full goroutine
stacktrace, which tells a user nothing and hides the one fact that matters: their sign-in expired
and they need to reconnect.

Only the reasons a user can DO something about get a translation. Anything unrecognised keeps its
raw tail, because a wrong guess is worse than an ugly truth.
"""
from __future__ import annotations

import json
import re
from typing import List, Optional, Tuple

from typeguard import typechecked

# (needle, what to tell the user). Ordered: the first match wins, so put the specific ones first.
P_KNOWN_FAILURES: List[Tuple[str, str]] = [
    ("invalid_auth", "This connection's sign-in has expired. Reconnect it to keep using these tools."),
    ("authentication failed", "This connection's sign-in has expired. Reconnect it to keep using these tools."),
    ("authentication required", "This connection needs to be signed in before its tools can load."),
    ("token_revoked", "Access was revoked on the provider's side. Reconnect to grant it again."),
    ("account_inactive", "The connected account is inactive on the provider's side."),
    ("missing_scope", "The connected account is missing a permission this server needs. Reconnect to re-approve."),
    ("rate limited", "The provider is rate-limiting us right now. Try again in a few minutes."),
    ("enoent", "The server's program could not be found on this machine."),
    ("eacces", "This machine refused to run the server's program (permission denied)."),
]


@typechecked
def p_message_from_json_log(line: str) -> Optional[str]:
    """Structured loggers bury the useful sentence in a `message` field next to a stacktrace."""
    try:
        parsed = json.loads(line)
    except (json.JSONDecodeError, ValueError):
        return None
    if not isinstance(parsed, dict):
        return None
    for key in ("message", "msg", "error"):
        value = parsed.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


@typechecked
def readable_mcp_failure(stderr_tail: str) -> str:
    """A sentence for the user, or the raw tail when we genuinely do not recognise it."""
    tail = (stderr_tail or "").strip()
    if not tail:
        return "The server exited immediately and said nothing about why."

    lowered = tail.lower()
    for needle, friendly in P_KNOWN_FAILURES:
        if needle in lowered:
            return friendly

    # Not a known cause, so keep the truth but drop the goroutine dump and any JSON scaffolding.
    for raw_line in reversed(tail.splitlines()):
        extracted = p_message_from_json_log(raw_line.strip())
        if extracted:
            return re.sub(r"\s+", " ", extracted)[:300]
    return re.sub(r"\s+", " ", tail)[:300]
