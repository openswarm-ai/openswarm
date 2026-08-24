"""redact_for_telemetry is the wall between a model_error diagnostic and a key
leak: in own_key mode the subprocess stderr we now attach can echo the user's
provider key, so these tests pin that no secret shape survives while the actual
error text (the whole point of capturing stderr) does.

The secret-shaped inputs are built by concatenation on purpose: no contiguous
key-shaped literal lands in this source file (so it never trips gitleaks or
alarms a reader), yet the runtime values are still key-shaped enough to exercise
the scrub. None of these are real keys; they unlock nothing."""
import asyncio

from backend.apps.agents.core.error_classify import (
    capacity_retry_wait,
    is_auth_error,
    is_cli_binary_missing,
    is_context_overflow_error,
    is_free_trial_exhausted,
    is_transient_capacity_error,
    is_unknown_model_error,
)
from backend.apps.agents.core.redact_for_telemetry import redact_for_telemetry
from backend.apps.agents.core.first_real_exception import first_real_exception

# Verbatim field strings from prod analytics (2026-07): the exact shapes users hit.
P_FIELD_POOL_BUSY = (
    "Error code: 429 - {'type': 'error', 'error': {'type': 'free_pool_busy', "
    "'message': \"OpenSwarm's free pool is busy right now. Sign in for more, or try again shortly.\"}}"
)
P_FIELD_CLI_MISSING = (
    "Claude Code not found at: C:\\Users\\Rishi\\AppData\\Local\\openswarm\\app-1.5.6\\resources"
    "\\python-env\\Lib\\site-packages\\claude_agent_sdk\\_bundled\\claude.exe"
)


def test_redacts_provider_key_shapes_keeps_context():
    anthropic = "sk-" + "ant-" + "A" * 28
    openai = "sk-" + "B" * 24
    google = "AIza" + "C" * 30
    github = "ghp" + "_" + "D" * 24
    s = f"9router: invalid x-api-key {anthropic} {openai} {google} {github}"
    out = redact_for_telemetry(s)
    for secret in (anthropic, openai, google, github):
        assert secret not in out
    assert "[redacted]" in out
    # The diagnostic signal survives, that's the reason we capture stderr at all.
    assert "9router: invalid x-api-key" in out


def test_redacts_bearer_and_key_value():
    bearer_token = "E" * 24
    kv_value = "F" * 16
    s = "Authorization: " + "Bearer " + bearer_token + "\n" + "api_key=" + kv_value
    out = redact_for_telemetry(s)
    assert bearer_token not in out
    assert kv_value not in out


def test_keeps_tail_and_bounds_length():
    # The real error lands at the end of the stderr stream, so we keep the tail.
    s = "old noise\n" * 500 + "Command failed: ENOENT spawn 9router"
    out = redact_for_telemetry(s, limit=120)
    assert len(out) <= 120
    assert "Command failed: ENOENT spawn 9router" in out


def test_empty_is_safe():
    assert redact_for_telemetry("") == ""


def test_field_pool_busy_is_transient_and_retried():
    e = Exception(P_FIELD_POOL_BUSY)
    assert is_transient_capacity_error(e)
    assert capacity_retry_wait(e, 0) == 5
    # Must not be claimed by the branches that would surface a card instead of retrying.
    assert not is_free_trial_exhausted(e)
    assert not is_auth_error(e)


def test_cli_missing_matches_field_string_and_nothing_else_claims_it():
    e = Exception(P_FIELD_CLI_MISSING)
    assert is_cli_binary_missing(e)
    assert not is_transient_capacity_error(e)
    assert not is_auth_error(e)
    assert not is_unknown_model_error(e)


def test_cli_missing_matches_sdk_exception_type():
    class CLINotFoundError(Exception):
        pass
    assert is_cli_binary_missing(CLINotFoundError("whatever text"))


# The overflow family across providers; each of these shapes used to kill the run with either a raw error card or (worse) a fake "completed".
P_OVERFLOW_SHAPES = (
    "API Error: 400 {\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"message\":\"prompt is too long: 214384 tokens > 200000 maximum\"}}",
    "Error code: 429 - extra usage is required for long context",
    "This model's maximum context length is 128000 tokens. However, your messages resulted in 131074 tokens.",
    "Error code: 400 - {'error': {'code': 'context_length_exceeded'}}",
    "The input token count (1048577) exceeds the maximum number of tokens allowed (1048576).",
    "Error code: 429 - Request too large for gpt-4o on tokens per min (TPM)",
)


def test_overflow_family_is_claimed_and_never_retried_verbatim():
    for s in P_OVERFLOW_SHAPES:
        e = Exception(s)
        assert is_context_overflow_error(e), s
        # Retrying the identical oversized request is guaranteed futile; the valve owns it.
        assert not is_transient_capacity_error(e), s
        assert capacity_retry_wait(e, 0) is None, s


def test_overflow_does_not_claim_ordinary_errors():
    for s in (P_FIELD_POOL_BUSY, P_FIELD_CLI_MISSING, "529 overloaded, try again shortly", "401 invalid x-api-key"):
        assert not is_context_overflow_error(Exception(s)), s


def test_first_real_exception_unwraps_nested_groups():
    boom = ValueError("boom")
    group = BaseExceptionGroup(
        "outer", [asyncio.CancelledError(), ExceptionGroup("inner", [boom])]
    )
    assert first_real_exception(group) is boom


def test_first_real_exception_all_cancelled_is_none():
    group = BaseExceptionGroup("outer", [asyncio.CancelledError()])
    assert first_real_exception(group) is None


def test_first_real_exception_plain_passthrough():
    boom = RuntimeError("x")
    assert first_real_exception(boom) is boom


def test_cert_failure_is_never_transient():
    import httpx
    from backend.apps.agents.core.error_classify import is_cert_failure, is_transient_capacity_error
    exc = httpx.ConnectError("[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed: self-signed certificate")
    assert is_cert_failure(exc) is True
    # httpx.ConnectError subclasses the transient TransportError; the cert check must win (ENG-218).
    assert is_transient_capacity_error(exc) is False
    for msg in ("unable to get local issuer certificate", "certificate has expired", "Hostname mismatch"):
        assert is_transient_capacity_error(httpx.ConnectError(msg)) is False
    # A cert-free transport hiccup keeps its transient classification.
    assert is_transient_capacity_error(httpx.ConnectError("Connection refused")) is True


def test_a_malformed_request_is_never_transient_however_it_is_dressed():
    # 9router appends "(reset after Ns)" to EVERYTHING, and that substring is load-bearing in two
    # separate branches, so a deterministic 400 parked on a 900s ladder forever (ENG-395/ENG-394).
    from backend.apps.agents.core.error_classify import is_transient_capacity_error
    b400 = ('API Error: 400 {"error":{"message":"[claude/claude-opus-5] [400]: Tool X cannot have '
            'both defer_loading=true and cache_control set. (reset after 21s)"}}')
    assert is_transient_capacity_error(RuntimeError(b400)) is False


def test_the_reset_hint_still_rescues_what_it_was_written_for():
    # The controls that keep the fix from being a blanket kill: a rotating token really does heal,
    # and a "400" that is a line number or a token count is not a status at all (ENG-365).
    from backend.apps.agents.core.error_classify import is_transient_capacity_error as t
    assert t(RuntimeError("API Error: 401 unauthorized (reset after 1m 57s)")) is True
    assert t(RuntimeError('API Error: 429 {"message":"rate_limit_error (reset after 21s)"}')) is True
    assert t(RuntimeError("File runner.py, line 400, in execute (reset after 3s)")) is True
    assert t(RuntimeError("context has 4000 tokens (reset after 3s)")) is True


def test_the_retry_log_does_not_claim_a_transport_fault_it_did_not_classify():
    src = open("backend/apps/agents/manager/run/handle_run_error.py").read()
    assert 'p_why = "connection lost" if is_connection_lost(e) else "provider unavailable"' in src, \
        "the log sent a reader hunting a transport fault that was never classified"
