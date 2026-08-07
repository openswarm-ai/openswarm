"""Rigorous coverage for capacity_retry_wait, the transient-error backoff decision lifted
into error_classify.py next to the classifier it uses. It was previously inline + untestable
in the agent loop's retry while-loop."""

import anthropic
import httpx

from backend.apps.agents.core.error_classify import (
    CAPACITY_BACKOFFS,
    TRANSIENT_CAPACITY_PATTERNS,
    capacity_retry_wait,
)

# The classifier matches this proxy copy verbatim (a guaranteed-transient signal).
TRANSIENT = "No pool capacity available. Try again shortly."


def test_transient_returns_the_scheduled_backoff_for_each_attempt():
    waits = [capacity_retry_wait(Exception(TRANSIENT), i) for i in range(len(CAPACITY_BACKOFFS))]
    assert waits == CAPACITY_BACKOFFS  # escalates 5 -> 15 -> 45 -> 90 -> 180


def test_budget_exhausted_returns_none():
    assert capacity_retry_wait(Exception(TRANSIENT), len(CAPACITY_BACKOFFS)) is None
    assert capacity_retry_wait(Exception(TRANSIENT), len(CAPACITY_BACKOFFS) + 3) is None


def test_negative_attempt_returns_none():
    assert capacity_retry_wait(Exception(TRANSIENT), -1) is None


def test_non_transient_error_never_retries():
    assert capacity_retry_wait(Exception("invalid_request_error: bad params"), 0) is None
    assert capacity_retry_wait(ValueError("a totally unrelated bug"), 0) is None


def test_transient_signal_can_arrive_only_via_the_stderr_tail():
    # the CLI's ProcessError stringifies to something generic; the real cause is in stderr
    generic = Exception("upstream hiccup")
    assert capacity_retry_wait(generic, 0) is None                      # nothing transient yet
    assert capacity_retry_wait(generic, 0, extra_text=TRANSIENT) == 5   # stderr reveals it


# --- failures that say nothing a word list can read ---------------------------------------------
# Measured live: two browser runs died mid-task on anthropic.APIConnectionError, which stringifies
# to the bare "Connection error." The pattern list scored that NON-transient, so one network blip
# threw away work that was already several steps in. These pin the type-based classification.

def p_req():
    return httpx.Request("POST", "https://api.anthropic.com/v1/messages")


def test_a_bare_connection_error_is_transient():
    exc = anthropic.APIConnectionError(request=p_req())
    assert str(exc) == "Connection error."                    # no code, no ECONNRESET, no wording
    assert not TRANSIENT_CAPACITY_PATTERNS.search(str(exc))   # nothing for the list to match on
    assert capacity_retry_wait(exc, 0) == 5


def test_transport_and_timeout_failures_are_transient():
    for exc in (
        anthropic.APITimeoutError(request=p_req()),
        httpx.ConnectError("nope"),
        httpx.ReadTimeout("nope"),
        httpx.RemoteProtocolError("server disconnected"),
        ConnectionResetError(),
        TimeoutError(),
    ):
        assert capacity_retry_wait(exc, 0) == 5, f"{type(exc).__name__} should retry"


def test_an_auth_failure_stays_non_transient_even_when_it_is_a_transport_type():
    # Retrying a 401 five times burns 335s of backoff and fails anyway, so wording still wins.
    assert capacity_retry_wait(ConnectionError("401 invalid token"), 0) is None


def test_a_transport_error_that_says_nothing_at_all_still_retries():
    # An exception stringifying to "" used to bail out before it was ever classified.
    assert capacity_retry_wait(httpx.ConnectError(""), 0) == 5


# --- the router-respawn family: turn-RESULT errors, which bypass capacity_retry_wait entirely ---
# The CLI reports "API Error: Unable to connect" as an error-shaped ResultMessage when our
# localhost 9Router is mid-respawn (a dev reload kills it, the watchdog revives it in seconds).
# TurnRunner consults is_router_unreachable_error on the TurnResultError text and resumes the turn
# instead of surfacing a terminal card; these pin exactly which texts qualify.

from backend.apps.agents.core.error_classify import is_router_unreachable_error


def test_the_cli_unable_to_connect_text_is_router_unreachable():
    live = ("The agent runtime reported this turn failed (error_during_execution). "
            "API Error: Unable to connect. Is the computer able to access the url?")
    assert is_router_unreachable_error(live)


def test_connection_refused_variants_are_router_unreachable():
    for text in ("ECONNREFUSED 127.0.0.1:20128", "connect: Connection refused", "fetch failed", "Connection error."):
        assert is_router_unreachable_error(text), text


def test_ordinary_turn_failures_are_not_router_unreachable():
    for text in (
        "The model hit its maximum output length before finishing (max_tokens).",
        "The model refused to continue this turn (refusal).",
        "invalid_request_error: tool schema rejected",
        "denied tools: Bash",
        "",
    ):
        assert not is_router_unreachable_error(text), text


# --- self-healing 401s: mid-refresh tokens must retry, never flash the reconnect card ------------
from backend.apps.agents.core.error_classify import is_auth_error


def test_reset_window_401_is_transient_not_auth():
    # Verbatim live codex body (2026-08-06): healed itself two minutes later, chats were fine.
    body = '[codex/gpt-5.2] [401]: Provided authentication token is expired. Please try signing in again. (reset after 1m 57s)'
    assert not is_auth_error(Exception(body)), "a self-healing 401 must not show the reconnect card"
    assert capacity_retry_wait(Exception(body), 0) == 5, "and the turn silently retries through the window"


def test_genuine_auth_death_still_cards():
    assert is_auth_error(Exception("401 unauthorized: invalid authentication credentials"))
    assert capacity_retry_wait(Exception("401 unauthorized: invalid api key"), 0) is None
