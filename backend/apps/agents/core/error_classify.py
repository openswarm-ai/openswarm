import re
from typing import Optional

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


def redact_for_telemetry(text: str, *, limit: int = 2000) -> str:
    """Scrub secret-shaped substrings, then keep the tail (where the real error
    lands), bounded so a runaway log can't bloat the payload. Every raw
    error/stderr string goes through here before it leaves the machine."""
    if not text:
        return ""
    for pat in P_TELEMETRY_SECRET_PATTERNS:
        text = pat.sub("[redacted]", text)
    return text[-limit:]


# Patterns that indicate an upstream transient problem (overload / rate limit / infra blip), safe to silently retry with backoff. Checked against the stringified exception from claude_agent_sdk / Claude CLI.
TRANSIENT_CAPACITY_PATTERNS = re.compile(
    r"(?:\b(?:429|500|502|503|504|529)\b"
    r"|overloaded"
    r"|service\s+(?:temporarily\s+)?unavailable"
    r"|at\s+capacity"
    r"|try\s+again\s+shortly"
    r"|internal\s+server\s+error"
    r"|rate[_\s-]?limit(?:_error)?"
    r"|ECONNRESET|ETIMEDOUT|ENETUNREACH|fetch\s+failed"
    r"|resource[_\s-]?exhausted"
    r"|upstream\s+connect\s+error)",
    re.IGNORECASE,
)

# A first message ships the full tool schema; 9Router rewrites Anthropic tools[].input_schema into Gemini function_declarations / OpenAI params, and a construct it can't translate makes the provider 400 (INVALID_ARGUMENT) with zero tokens. That is NOT auth, reconnecting won't help, the request shape is wrong, so we classify it apart and stop the catch-all from showing a "reconnect your subscription" card for a tool-schema 400.
P_TRANSLATION_ERROR_PATTERNS = re.compile(
    r"(?:function_declarations"
    r"|invalid_argument"
    r"|invalid\s+json\s+payload"
    r"|unknown\s+name\b"
    r"|cannot\s+find\s+field"
    r"|proto\s+field"
    r"|input_schema"
    r"|\btools\[\d+\]"
    r")",
    re.IGNORECASE,
)

# Patterns that look rate-limit-ish but are actually non-transient (user quota, auth, context-window tier gate). Must NOT retry, upgrading, reauthing, or trimming context is required. The long-context-required variant is what Anthropic returns when an OAuth Pro/Max account ships a request whose input exceeds the 200K standard tier and would need the "extra usage" tier; the user can't recover by waiting, so we surface it instead of looping.
NON_TRANSIENT_PATTERNS = re.compile(
    r"(?:usage\s+cap\s+exceeded"
    r"|reached\s+your\s+OpenSwarm.*plan\s+limit"
    r"|no\s+active\s+subscription"
    r"|subscription\s+(?:canceled|past_due)"
    r"|invalid.*token"
    r"|missing\s+bearer\s+token"
    r"|extra\s+usage\s+is\s+required\s+for\s+long\s+context"
    r"|long\s+context\s+(?:requests?\s+)?(?:requires?|not\s+(?:available|enabled))"
    r"|free_trial_exhausted|used\s+your\s+free"
    r"|401|403)",
    re.IGNORECASE,
)


@typechecked
def is_long_context_error(exc: BaseException, extra_text: str = "") -> bool:
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


@typechecked
def is_free_trial_exhausted(exc: BaseException, extra_text: str = "") -> bool:
    """True when the cloud says the machine's free runs are spent (a 402 with
    type free_trial_exhausted). The catch-all path uses this to flip back to
    own_key and show a friendly connect-a-model upsell instead of a raw error.
    """
    combined = f"{exc!s}\n{extra_text}".strip()
    if not combined:
        return False
    return bool(re.search(
        r"free_trial_exhausted|used\s+your\s+free\s+(?:openswarm\s+)?runs",
        combined,
        re.IGNORECASE,
    ))


@typechecked
def is_translation_error(exc: BaseException, extra_text: str = "") -> bool:
    """True when the upstream 400 is a tool-schema / protocol translation
    failure (9Router rewriting Anthropic tools into Gemini function_declarations
    or OpenAI params), not auth or capacity. Kept distinct so the catch-all
    stops mislabeling a schema 400 as an expired-subscription reconnect card."""
    combined = f"{exc!s}\n{extra_text}".strip()
    if not combined:
        return False
    return bool(P_TRANSLATION_ERROR_PATTERNS.search(combined))


@typechecked
def is_auth_error(exc: BaseException, extra_text: str = "") -> bool:
    """True when the upstream error is a 401/403 auth failure.

    Used by the catch-all error path to surface a friendly "subscription
    expired / reconnect" card instead of dumping the raw 401 JSON. The most
    common cause: the OpenSwarm Pro bearer or 9Router OAuth token has expired
    while the UI still shows the connection as 'connected'.
    """
    combined = f"{exc!s}\n{extra_text}".strip()
    if not combined:
        return False
    # A tool-schema translation 400 can carry provider/connection wording that trips the auth regex below; it isn't auth, so don't claim it is.
    if is_translation_error(exc, extra_text):
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


@typechecked
def is_unknown_model_error(exc: BaseException, extra_text: str = "") -> bool:
    """True when the upstream rejects the model code itself (e.g. a ChatGPT/Codex
    subscription whose plan doesn't expose the GPT model id we send: code 1211
    'Unknown Model, please check the model code'). The fix isn't retry, it's a
    different model or an API key, so we surface that instead of the raw JSON.
    """
    combined = f"{exc!s}\n{extra_text}".strip()
    if not combined:
        return False
    return bool(re.search(
        r"unknown\s+model"
        r"|check\s+the\s+model\s+code"
        r"|\b1211\b"
        r"|model[_\s-]?not[_\s-]?found"
        r"|does\s+not\s+exist.*model|model.*does\s+not\s+exist",
        combined,
        re.IGNORECASE,
    ))


def parse_retry_after(exc: BaseException, extra_text: str = "") -> int | None:
    """Best-effort seconds-until-retry pulled from a throttle error; None if the
    upstream didn't say. Only used to label the rate-limit pill, so a miss just
    means the pill shows no countdown, never anything load-bearing."""
    combined = f"{exc!s}\n{extra_text}"
    # "1m 59s" / "2m" / "45s" (reset-window phrasing Codex/Anthropic use).
    m = re.search(r"\b(?:(\d{1,2})\s*m(?:in)?)?\s*(\d{1,3})\s*s(?:ec)?\b", combined, re.IGNORECASE)
    if m and (m.group(1) or m.group(2)):
        return int(m.group(1) or 0) * 60 + int(m.group(2) or 0)
    # "retry-after: 30" / "try again in 2 minutes".
    m = re.search(r"(?:retry[-\s]?after|try\s+again\s+in)\D{0,8}(\d{1,4})\s*(m|min|minute|s|sec|second)?", combined, re.IGNORECASE)
    if m:
        n = int(m.group(1))
        unit = (m.group(2) or "s").lower()
        return n * 60 if unit.startswith("m") else n
    return None


@typechecked
def is_transient_capacity_error(exc: BaseException, extra_text: str = "") -> bool:
    # The Claude CLI's underlying ProcessError stringifies to a generic "Command failed with exit code 1 / Check stderr output for details"; the real cause (rate_limit_error / No pool capacity available / 429 / overloaded) only surfaces in the subprocess's stderr stream, which we capture via the SDK's `stderr` callback and pass in as extra_text. Classify against both so we catch capacity errors regardless of which channel carried the message.
    combined = f"{exc!s}\n{extra_text}".strip()
    if not combined:
        return False
    if NON_TRANSIENT_PATTERNS.search(combined):
        return False
    if TRANSIENT_CAPACITY_PATTERNS.search(combined):
        return True
    # Pool-exhaustion copy from the OpenSwarm proxy ("No pool capacity available. Try again shortly."), matches the capacity family too.
    if re.search(r"no\s+pool\s+capacity", combined, re.IGNORECASE):
        return True
    return False


# Exponential-ish backoff schedule (seconds) for silently retrying a transient upstream capacity error before giving up and surfacing the rate-limit pill.
CAPACITY_BACKOFFS = [5, 15, 45, 90, 180]


@typechecked
def capacity_retry_wait(exc: BaseException, attempt: int, extra_text: str = "") -> Optional[int]:
    """Seconds to wait before retrying a transient upstream capacity error (429 / overload /
    5xx / network blip), or None when the error isn't transient or the backoff budget for
    this turn is already spent. Keeps the retry DECISION testable; the loop owns the wait."""
    if is_transient_capacity_error(exc, extra_text=extra_text) and 0 <= attempt < len(CAPACITY_BACKOFFS):
        return CAPACITY_BACKOFFS[attempt]
    return None


@typechecked
def is_out_of_tokens(exc: BaseException, extra_text: str = "") -> bool:
    combined = f"{exc!s}\n{extra_text}".strip()
    if not combined:
        return False
    return bool(re.search(
        r"usage\s+cap\s+exceeded"
        r"|reached\s+your\s+OpenSwarm.*plan\s+limit"
        r"|usage\s+limit"
        r"|insufficient_quota"
        r"|exceeded\s+your\s+current\s+quota"
        r"|quota\s+exceeded"
        r"|credit\s+balance\s+is\s+too\s+low"
        r"|out\s+of\s+credits",
        combined,
        re.IGNORECASE,
    ))


@typechecked
def is_context_pressure_death(exc: BaseException, compact_boundaries: int, extra_text: str = "") -> bool:
    """The CLI autocompact-thrash class: the process compacted during this turn and then
    died with a bare exit-1 ProcessError (its thrash detector gives up after 3 refill
    cycles, which can straddle turns on a persistent client, so one boundary in the dying
    turn is the reliable tell). Only claims deaths no other classifier owns, so auth/
    capacity/credit errors keep their specific handling; a misfire costs one bounded
    silent retry, a miss just means today's error card.
    """
    if compact_boundaries < 1:
        return False
    # Type-name check, not isinstance: the SDK is lazy-imported (mock mode must work without it), mirroring the client-pool dead-client idiom.
    if "ProcessError" not in type(exc).__name__:
        return False
    for p_claimed_by in (
        is_long_context_error, is_transient_capacity_error, is_free_trial_exhausted,
        is_out_of_tokens, is_auth_error, is_unknown_model_error,
    ):
        if p_claimed_by(exc, extra_text=extra_text):
            return False
    return True


@typechecked
def extract_reset_hint(text: str) -> str:
    """Pull a human reset phrase ('at 7:42 AM', 'in 2h 30m', 'after 1m 59s') out of
    a provider usage error so we can tell the user when their limit comes back.
    """
    if not text:
        return ""
    m = re.search(
        r"(?:try\s+again|resets?|reset)\s+((?:in|at|after)\s+[^.\n)]{1,40})",
        text,
        re.IGNORECASE,
    )
    return m.group(1).strip() if m else ""
