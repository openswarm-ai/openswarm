import re
from typing import Optional, Tuple

import httpx
from typeguard import typechecked

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
    r"|reset\s+after\s+\d"
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

# A 401/403 only counts with auth context around it: a traceback's "line 401," or a node stack's ":401:12" is not a sign-in failure, and matching them bare stalled healthy GPT runs 75s behind a false "token just rotated" notice (ENG-365).
AUTH_STATUS_RE = (
    r"(?:\b(?:http|status(?:_code)?|error(?:\s+code)?|code|response|request\s+failed|got|received|returned|responded(?:\s+with)?)\b\s*[:=]?\s*\(?\s*(?:401|403)\b"
    r"|\b(?:401|403)\b[^\n]{0,24}?\b(?:unauthori[sz]ed|forbidden|client\s+error|authentication(?:_error)?|invalid|expired|token|credentials?|subscription|bearer|api[_\s-]?key|upstream|provider|api)\b"
    r"|\(\s*(?:401|403)\s*\))"
)
P_AUTH_STATUS = re.compile(AUTH_STATUS_RE, re.IGNORECASE)


@typechecked
def has_auth_status(text: str) -> bool:
    return bool(P_AUTH_STATUS.search(text))


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
    r"|blocked\s+as\s+it\s+seems\s+to\s+violate|legal/aup|acceptable\s+use\s+policy"
    r"|" + AUTH_STATUS_RE + r")",
    re.IGNORECASE,
)


# The provider's abuse classifier declined the REQUEST itself (Anthropic: "blocked as it seems to violate ... reverse engineering or duplicating model outputs"); retrying the same bytes is guaranteed futile.
# The shape a provider's own refusal arrives in ("API Error: 400 {...}"), as opposed to prose that
# merely discusses policy. Used to make sure a refusal guard can never eat a genuine answer.
P_PROVIDER_ENVELOPE = re.compile(
    r"API\s+Error\b|\"type\"\s*:\s*\"error\"|\"error\"\s*:\s*\{|status\s*(?:code)?\s*[:=]\s*4\d\d",
    re.IGNORECASE,
)

# "Usage Policy" is the wording the CLI itself prints; "Acceptable Use Policy" is the API's. Both are
# the same refusal, and matching only one under-counted the class for days.
P_CONTENT_POLICY_BLOCK = re.compile(
    r"blocked\s+as\s+it\s+seems\s+to\s+violate"
    r"|violat\w*\s+(?:our\s+)?(?:acceptable\s+use|usage)\s+policy"
    r"|legal/aup"
    r"|acceptable\s+use\s+policy"
    r"|duplicating\s+model\s+outputs",
    re.IGNORECASE,
)

# The CLI hands the filter's verdict back as if the model had written it: no "API Error:", no status
# code, just prose. It is still the provider talking, and letting it stand as assistant content is
# exactly how policy language ends up in every later request in that chat.
P_REFUSAL_OPENER = re.compile(r"unable\s+to\s+respond\s+to\s+this\s+request", re.IGNORECASE)
P_REFUSAL_OPENS_WITHIN = 60


@typechecked
def is_content_policy_block(text: str) -> bool:
    return bool(P_CONTENT_POLICY_BLOCK.search(text))


@typechecked
def opens_with_provider_refusal(text: str) -> bool:
    """A refusal that OPENS the message, the same "must open it" rule the router-stamp check uses.

    An answer that merely mentions a policy keeps its work; only a reply that is nothing but the
    refusal is treated as the provider speaking.
    """
    stripped = text.strip()
    p_at = P_REFUSAL_OPENER.search(stripped)
    return bool(p_at and p_at.start() <= P_REFUSAL_OPENS_WITHIN and is_content_policy_block(stripped))


# Asking one agent to reproduce another's work verbatim is the shape the subscription lane refuses ("duplicating model outputs"). Our own handoff prompts are model-authored and land in a forked child as its user turn, which is where a third of one user's blocks came from; one agent even diagnosed itself: "my phrasing about 'dumping verbatim' tripped it".
P_EXTRACTION_ASK = re.compile(
    r"\bverbatim\b|\bword[- ]for[- ]word\b|complete\s+dump|\bdump\s+(?:of|everything|all|your)|"
    r"(?:exact|full|entire|complete)\s+(?:\w+\s+){0,2}(?:text|body|output|response|reply|contents?|transcript|work)|"
    r"repeat\s+(?:back\s+)?(?:what|your|the)|reproduce\s+(?:the|your|it)",
    re.IGNORECASE,
)


@typechecked
def defuse_extraction_ask(text: str) -> str:
    """Rewrite a handoff prompt that asks another agent to reproduce output. The delegation prompt is
    written by the model at call time, so the only place this can be made unrepresentable is the
    dispatch boundary: what leaves here can never carry the shape."""
    if not text or not P_EXTRACTION_ASK.search(text):
        return text
    return (text + "\n\nAnswer in your own words as a short task-relevant summary. Do not reproduce "
            "any earlier message, output, or file contents verbatim.")


@typechecked
def neutralize_provider_refusal(text: str) -> str:
    """A delegated agent's provider refusal must never travel back as CONTENT. Measured 2026-08-21:
    a blocked child's refusal came home as its result and was then stored as the PARENT's own
    assistant text (264 times across 161 chats), so the parent chat carried policy-violation
    language as the model's own words into every later request. Returns a short neutral status
    instead, and leaves any real answer untouched."""
    if not text:
        return text
    # Refusal WORDING alone is not enough to destroy a delegated answer. Ask an agent to summarise a
    # site's Acceptable Use Policy and its real, correct answer contains the very phrases this
    # matches; replacing it would delete the user's work and tell nobody, which is a worse bug than
    # the one this guard exists for. A relayed refusal is always wrapped in a provider ENVELOPE, and
    # prose about policy never is, so require both before anything is thrown away.
    if not P_PROVIDER_ENVELOPE.search(text) and not opens_with_provider_refusal(text):
        return text
    if is_content_policy_block(text) or "unable to respond to this request" in text.lower():
        return ("That agent could not answer this request and returned no usable result. "
                "Do not repeat or quote its response; continue with what you already have, "
                "or do the work directly.")
    return text


# Real account STATES a retry cannot fix: the subscription is gone, not the token. These must keep dying to the banner, or a canceled account silently burns a request per turn forever.
P_SUBSCRIPTION_STATE_PATTERNS = re.compile(
    r"(?:no\s+active\s+subscription"
    r"|subscription\s+(?:canceled|past_due)"
    r"|free_trial_exhausted|used\s+your\s+free)",
    re.IGNORECASE,
)

AUTH_RESUME_WAIT_CAP = 120

# A codex/GPT subscription token rotates every 1-2 minutes; anything shorter than the window just
# retries into the same expiry.
CODEX_ROTATION_RESUME_WAIT = 75

P_CODEX_ROTATION_PATTERNS = re.compile(
    r"(?:\[?codex/|\bcx/|\bgpt-[0-9])"
    r".*?"
    r"(?:authentication\s+token\s+(?:is|has)\s+expired|token\s+expired|" + AUTH_STATUS_RE + r")"
    r"|(?:authentication\s+token\s+(?:is|has)\s+expired|token\s+expired|" + AUTH_STATUS_RE + r")"
    r".*?"
    r"(?:\[?codex/|\bcx/|\bgpt-[0-9])",
    re.IGNORECASE | re.DOTALL,
)


@typechecked
def auth_resume_wait(exc: BaseException, attempt: int, extra_text: str = "") -> Optional[int]:
    """Seconds to wait before ONE refresh-and-resume of an auth-shaped turn failure (expired or
    rotating token, 401/403), or None when the failure names a real account state (canceled
    subscription, spent trial) that waiting cannot fix, or the single-attempt budget is spent.
    Field incident (Alexander, 2026-08-14): a token expiring mid-long-task was classified
    non-transient and killed the run at the banner; every big task died the same way. A misfire
    here costs one bounded extra request; a miss is that death."""
    if attempt >= 1:
        return None
    combined = f"{exc!s}\n{extra_text}".strip()
    if not combined:
        return None
    if P_SUBSCRIPTION_STATE_PATTERNS.search(combined):
        return None
    if is_translation_error(exc, extra_text):
        return None
    if not re.search(
        AUTH_STATUS_RE
        + r"|unauthori[sz]ed"
        r"|invalid\s+authentication"
        r"|invalid.*api[_\s-]?key"
        r"|invalid.*token"
        r"|missing\s+bearer\s+token"
        r"|authentication\s+token\s+(?:is|has)\s+expired"
        r"|token\s+expired",
        combined,
        re.IGNORECASE,
    ):
        return None
    hinted = parse_retry_after(exc, extra_text)
    if hinted is not None:
        return min(hinted + 5, AUTH_RESUME_WAIT_CAP)
    # Codex tokens rotate on a 1-2 minute cadence, so a 20s resume lands back INSIDE the same
    # window and spends the one attempt on a failure that was always going to fail. This is the
    # turn-level twin of the ENG-361 wait: without it that fix never gets a say, because this
    # retry runs first (drill C5/D6, 2026-08-20).
    if P_CODEX_ROTATION_PATTERNS.search(combined):
        return CODEX_ROTATION_RESUME_WAIT
    return 20


@typechecked
def is_router_unreachable_error(text: str) -> bool:
    """True when a turn-result error is the CLI failing to REACH its endpoint (our localhost
    9Router, which every provider call goes through). A dev reload kills and respawns the router,
    so this is a seconds-long outage: the caller re-ensures the router and resumes the turn
    instead of surfacing a terminal error card."""
    if not text.strip():
        return False
    return bool(re.search(
        r"unable\s+to\s+connect"
        r"|econnrefused"
        r"|connection\s+refused"
        r"|fetch\s+failed"
        r"|connection\s+error",
        text,
        re.IGNORECASE,
    ))


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
def is_context_overflow_error(exc: BaseException, extra_text: str = "") -> bool:
    """The context-window overflow family across providers: Anthropic's 'prompt is too
    long' 400 and long-context tier gate, OpenAI's 'maximum context length' /
    'context_length_exceeded' / 'request too large', Gemini's 'input token count exceeds'.
    Gates the reactive compact-and-retry valve in run_agent_loop; a misfire costs one
    bounded fresh-session recap retry, a miss means today's terminal error card.
    """
    if is_long_context_error(exc, extra_text):
        return True
    combined = f"{exc!s}\n{extra_text}".strip()
    if not combined:
        return False
    return bool(re.search(
        r"prompt\s+is\s+too\s+long"
        r"|maximum\s+context\s+length"
        r"|context[_\s-]?length[_\s-]?exceeded"
        r"|input\s+token\s+count[^.\n]{0,40}exceeds"
        r"|exceeds?\s+the\s+(?:maximum\s+)?(?:context|token)\s+(?:window|limit)"
        r"|request\s+too\s+large",
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
    # A 401 that names its own recovery window ("reset after 1m 57s") is a token mid-refresh; it
    # heals itself, so the reconnect card would lie. The transient classifier retries it instead.
    if re.search(r"reset\s+after|try\s+again\s+in", combined, re.IGNORECASE):
        return False
    return bool(re.search(
        AUTH_STATUS_RE
        + r"|invalid\s+authentication\s+credentials"
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


@typechecked
def is_cli_binary_missing(exc: BaseException, extra_text: str = "") -> bool:
    """True when the bundled Claude CLI binary is gone from disk (the SDK's
    CLINotFoundError at spawn time). Field data shows this only on Windows,
    where antivirus quarantine deletes the unsigned exe out from under an
    installed app; restore-from-quarantine or reinstall is the only fix, so
    the card must say that instead of dumping the dead path.
    """
    if "CLINotFoundError" in type(exc).__name__:
        return True
    combined = f"{exc!s}\n{extra_text}".strip()
    if not combined:
        return False
    return bool(re.search(r"claude\s+code\s+not\s+found", combined, re.IGNORECASE))


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


# anthropic.APIConnectionError stringifies to the bare "Connection error.", so the patterns above
# score it NON-transient and one network hiccup throws away a whole run (measured live, twice). A
# transport failure is transient by construction, so classify by TYPE, which no rewording breaks.
# Built lazily: importing the anthropic SDK at module scope cost 224ms of every backend boot.
p_transient_exc_types: Optional[Tuple[type, ...]] = None


def p_get_transient_exc_types() -> Tuple[type, ...]:
    global p_transient_exc_types
    if p_transient_exc_types is None:
        import anthropic

        p_transient_exc_types = (
            anthropic.APIConnectionError, anthropic.InternalServerError,  # APITimeoutError subclasses the first
            httpx.TransportError, ConnectionError, TimeoutError)          # connect/read/pool timeouts, protocol errors
    return p_transient_exc_types


# A broken cert chain is deterministic per host (corporate TLS-inspection proxy, clock skew, stale
# CA bundle): it never heals inside a retry schedule, so it must be checked BEFORE the exception-type
# tuple, because the raising httpx.ConnectError subclasses the transient httpx.TransportError.
CERT_FAILURE_PATTERNS = re.compile(
    r"certificate\s+verify\s+failed|CERTIFICATE_VERIFY_FAILED|unable\s+to\s+get\s+local\s+issuer"
    r"|self.signed\s+certificate|certificate\s+has\s+expired|hostname\s+mismatch",
    re.IGNORECASE,
)


@typechecked
def is_cert_failure(exc: BaseException, extra_text: str = "") -> bool:
    return bool(CERT_FAILURE_PATTERNS.search(f"{exc!s}\n{extra_text}"))


@typechecked
def is_connection_lost(exc: BaseException) -> bool:
    """True when the transport itself died, as opposed to the provider answering with a refusal.

    Both arrive as "transient", but they want different recoveries: a dead socket leaves the CLI
    holding a corpse and must respawn, while a 429 is a healthy connection carrying a NO, where
    respawning just spends a process to be told the same thing.
    """
    return isinstance(exc, p_get_transient_exc_types())


# A MALFORMED request: the provider will answer identically forever, so no wait helps. Deliberately
# narrow. 401 stays out (a rotating token really does heal, which is why the reset-hint rule exists),
# and so do 408/429. Matched only in status POSITION, so a "400" in a line number or a byte count
# cannot promote itself into a verdict (ENG-365 learned that the hard way with "line 401,").
P_PERMANENT_STATUS = re.compile(
    r"(?:API\s+Error:\s*|HTTP\s+|status(?:\s*code)?\s*[:=]\s*|\[)\s*(?:400|422)\b",
    re.IGNORECASE,
)


@typechecked
def is_transient_capacity_error(exc: BaseException, extra_text: str = "") -> bool:
    # The Claude CLI's underlying ProcessError stringifies to a generic "Command failed with exit code 1 / Check stderr output for details"; the real cause (rate_limit_error / No pool capacity available / 429 / overloaded) only surfaces in the subprocess's stderr stream, which we capture via the SDK's `stderr` callback and pass in as extra_text. Classify against both so we catch capacity errors regardless of which channel carried the message.
    combined = f"{exc!s}\n{extra_text}".strip()
    # An overflow can arrive dressed as a 429 ("request too large"); retrying the identical oversized request is guaranteed futile, the valve owns it.
    if is_context_overflow_error(exc, extra_text):
        return False
    # 335s of retries cannot fix a certificate; the user has to (ENG-218, reproduced against badssl).
    if is_cert_failure(exc, extra_text):
        return False
    # Nor can any wait fix a malformed request. Ahead of every hint-driven branch below on purpose:
    # 9router appends "(reset after Ns)" to EVERYTHING, and that substring appears in both the
    # reset-hint rule and TRANSIENT_CAPACITY_PATTERNS, so a deterministic 400 was parking on a 900s
    # ladder forever for a request that could never succeed (ENG-395, found via ENG-394).
    if combined and P_PERMANENT_STATUS.search(combined):
        return False
    # A failure that names its own recovery window ("reset after 1m 57s") heals itself, even when
    # it's dressed as a 401; the reset hint outranks the auth-shaped non-transient veto (caught live).
    if combined and re.search(r"reset\s+after\s+\d", combined, re.IGNORECASE):
        return True
    if combined and NON_TRANSIENT_PATTERNS.search(combined):
        return False
    # Ahead of the empty-string bail on purpose: what the exception IS doesn't depend on whether it bothered to say anything.
    if isinstance(exc, p_get_transient_exc_types()):
        return True
    if not combined:
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


# The CLI says this in its own words when it gives up after 3 refill cycles. It arrives two ways: a bare exit-1 ProcessError, and (on the persistent client) inside a ResultMessage that TurnRunner raises as a TurnResultError, which the exception-type gate below silently missed: measured on Alex's install 2026-08-21, 13 thrash deaths in under two hours all landed in the catch-all while the valve fired 4 times in ten days.
P_AUTOCOMPACT_THRASH = re.compile(r"autocompact\s+is\s+thrashing|context\s+refilled\s+to\s+the\s+limit", re.IGNORECASE)


@typechecked
def is_context_pressure_death(exc: BaseException, compact_boundaries: int, extra_text: str = "") -> bool:
    """The CLI autocompact-thrash class: the process compacted during this turn and then
    died, either with a bare exit-1 ProcessError (its thrash detector gives up after 3 refill
    cycles, which can straddle turns on a persistent client, so one boundary in the dying
    turn is the reliable tell) or with its own thrash verdict in the result text. Only claims
    deaths no other classifier owns, so auth/capacity/credit errors keep their specific
    handling; a misfire costs one bounded silent retry, a miss just means today's error card.
    """
    # The CLI naming its own thrash is self-identifying, so it needs no exception type and no boundary count.
    if not P_AUTOCOMPACT_THRASH.search(f"{exc!s}\n{extra_text}"):
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


