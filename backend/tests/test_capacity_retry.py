"""Rigorous coverage for capacity_retry_wait, the transient-error backoff decision lifted
into error_classify.py next to the classifier it uses. It was previously inline + untestable
in the agent loop's retry while-loop."""

from backend.apps.agents.core.error_classify import CAPACITY_BACKOFFS, capacity_retry_wait

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
