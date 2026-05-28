import re

# Patterns that indicate an upstream transient problem (overload / rate limit /
# infra blip), safe to silently retry with backoff. Checked against the
# stringified exception from claude_agent_sdk / Claude CLI.
_TRANSIENT_CAPACITY_PATTERNS = re.compile(
    r"(?:\b(?:429|500|502|503|504|529)\b"
    r"|overloaded"
    r"|service\s+(?:temporarily\s+)?unavailable"
    r"|at\s+capacity"
    r"|try\s+again\s+shortly"
    r"|internal\s+server\s+error"
    r"|rate[_\s-]?limit(?:_error)?"
    r"|ECONNRESET|ETIMEDOUT|ENETUNREACH|fetch\s+failed"
    r"|upstream\s+connect\s+error)",
    re.IGNORECASE,
)

# Patterns that look rate-limit-ish but are actually non-transient (user quota,
# auth, context-window tier gate). Must NOT retry, upgrading, reauthing, or
# trimming context is required. The long-context-required variant is what
# Anthropic returns when an OAuth Pro/Max account ships a request whose input
# exceeds the 200K standard tier and would need the "extra usage" tier; the
# user can't recover by waiting, so we surface it instead of looping.
_NON_TRANSIENT_PATTERNS = re.compile(
    r"(?:usage\s+cap\s+exceeded"
    r"|reached\s+your\s+OpenSwarm.*plan\s+limit"
    r"|no\s+active\s+subscription"
    r"|subscription\s+(?:canceled|past_due)"
    r"|invalid.*token"
    r"|missing\s+bearer\s+token"
    r"|extra\s+usage\s+is\s+required\s+for\s+long\s+context"
    r"|long\s+context\s+(?:requests?\s+)?(?:requires?|not\s+(?:available|enabled))"
    r"|401|403)",
    re.IGNORECASE,
)


def _is_long_context_error(exc: BaseException, extra_text: str = "") -> bool:
    """True when the upstream error is the 'long context tier required' 429.

    Used by the catch-all error path to emit a friendly context-overflow
    event instead of a generic system-error message.
    """
    combined = f"{exc!s}\n{extra_text}".strip()
    if not combined:
        return False
    return bool(re.search(
        r"extra\s+usage\s+is\s+required\s+for\s+long\s+context"
        r"|long\s+context\s+(?:requests?\s+)?(?:requires?|not\s+(?:available|enabled))",
        combined,
        re.IGNORECASE,
    ))


def _is_auth_error(exc: BaseException, extra_text: str = "") -> bool:
    """True when the upstream error is a 401/403 auth failure.

    Used by the catch-all error path to surface a friendly "subscription
    expired / reconnect" card instead of dumping the raw 401 JSON. The most
    common cause: the OpenSwarm Pro bearer or 9Router OAuth token has expired
    while the UI still shows the connection as 'connected'.
    """
    combined = f"{exc!s}\n{extra_text}".strip()
    if not combined:
        return False
    return bool(re.search(
        r"\b(401|403)\b"
        r"|invalid\s+authentication\s+credentials"
        r"|invalid.*api[_\s-]?key"
        r"|missing\s+bearer\s+token"
        r"|unauthori[sz]ed"
        r"|no\s+credentials\s+for\s+provider"
        r"|provider\s+not\s+(?:configured|connected|authorized)",
        combined,
        re.IGNORECASE,
    ))


def _is_transient_capacity_error(exc: BaseException, extra_text: str = "") -> bool:
    # The Claude CLI's underlying ProcessError stringifies to a generic
    # "Command failed with exit code 1 / Check stderr output for details";
    # the real cause (rate_limit_error / No pool capacity available / 429
    # / overloaded) only surfaces in the subprocess's stderr stream, which
    # we capture via the SDK's `stderr` callback and pass in as extra_text.
    # Classify against both so we catch capacity errors regardless of which
    # channel carried the message.
    combined = f"{exc!s}\n{extra_text}".strip()
    if not combined:
        return False
    if _NON_TRANSIENT_PATTERNS.search(combined):
        return False
    if _TRANSIENT_CAPACITY_PATTERNS.search(combined):
        return True
    # Pool-exhaustion copy from the OpenSwarm proxy ("No pool capacity
    # available. Try again shortly."), matches the capacity family too.
    if re.search(r"no\s+pool\s+capacity", combined, re.IGNORECASE):
        return True
    return False
