"""The auth refresh-and-resume seam (Alexander, 2026-08-14: every decently big task died at the
"Connection needs a refresh" banner). A token that expires or rotates MID-RUN is an auth-shaped
blip, not a dead account: the run must refresh and resume once before the terminal banner. A real
subscription STATE (canceled, past_due, trial spent) must keep dying to the banner, or a canceled
account silently burns a request per turn forever."""

import inspect

from backend.apps.agents.core.error_classify import AUTH_RESUME_WAIT_CAP, auth_resume_wait
from backend.apps.agents.manager.run import TurnRunner


# --------------------------------------------------------------------------- the decision function


def test_an_expired_token_qualifies_for_one_resume():
    assert auth_resume_wait(Exception("API Error: 401 authentication token is expired"), 0) is not None


def test_a_bare_401_qualifies():
    assert auth_resume_wait(Exception("Request failed: 401 Unauthorized"), 0) is not None


def test_the_cause_can_live_only_in_stderr():
    # The SDK's ProcessError stringifies to a generic shell; the 401 arrives via the stderr tail.
    exc = Exception("Command failed with exit code 1. Check stderr output for details.")
    assert auth_resume_wait(exc, 0, extra_text="upstream says: invalid token (401)") is not None


def test_a_canceled_subscription_never_resumes():
    assert auth_resume_wait(Exception("401: No active subscription"), 0) is None
    assert auth_resume_wait(Exception("Subscription canceled"), 0) is None
    assert auth_resume_wait(Exception("Subscription past_due, 403"), 0) is None


def test_a_spent_free_trial_never_resumes():
    assert auth_resume_wait(Exception("402 free_trial_exhausted"), 0) is None


def test_the_budget_is_exactly_one_attempt():
    exc = Exception("401 token expired")
    assert auth_resume_wait(exc, 0) is not None
    assert auth_resume_wait(exc, 1) is None


def test_a_translation_400_is_not_auth():
    # A tool-schema 400 can carry wording that trips auth regexes; resuming re-sends the same broken schema.
    assert auth_resume_wait(Exception("400 INVALID_ARGUMENT: tools[3].input_schema unknown name"), 0) is None


def test_a_non_auth_error_is_left_alone():
    assert auth_resume_wait(Exception("500 internal server error"), 0) is None
    assert auth_resume_wait(Exception(""), 0) is None


def test_a_reset_hint_paces_the_wait_and_is_capped():
    w = auth_resume_wait(Exception("401 authentication token is expired, reset after 1m 30s"), 0)
    assert w is not None and 90 < w <= AUTH_RESUME_WAIT_CAP


def test_the_exact_field_incident_shape_qualifies():
    # The banner Alexander hit is raised off these strings (MessageBubble auth matcher); the two
    # blip-shaped ones must resume, the account-state ones above must not.
    assert auth_resume_wait(Exception("Invalid bearer token"), 0) is not None
    assert auth_resume_wait(Exception("Missing bearer token"), 0) is not None


# --------------------------------------------------------------------------- the TurnRunner wiring


def test_the_error_result_path_consults_auth_resume_before_raising():
    src = inspect.getsource(TurnRunner)
    body = src.split("except TurnResultError", 1)[1].split("except Exception as e", 1)[0]
    assert "auth_resume_wait" in body, "the auth check must live on the TurnResultError path"
    assert body.index("auth_resume_wait") < body.index("raise"), "classify BEFORE the unconditional raise"
    assert 'options_kwargs["resume"]' in body.split("auth_resume_wait", 1)[1], "the retry must resume the CLI conversation"


def test_the_exception_path_consults_auth_resume_too():
    src = inspect.getsource(TurnRunner)
    body = src.split("except Exception as e", 1)[1]
    assert "auth_resume_wait" in body, "a 401 raised as an exception must get the same one resume"


def test_the_resume_actively_refreshes_credentials():
    src = inspect.getsource(TurnRunner)
    assert src.count("invalidate_health_cache") >= 2, "both paths must poke the credential health cache, not just wait"


def test_the_recovery_ledger_counts_auth_resumes():
    src = inspect.getsource(TurnRunner)
    assert "auth-resume" in src.split("record_recovery", 1)[0] or "p_auth_retry_attempt" in src.split("record_recovery", 1)[1].split(")", 2)[1], \
        "a survived auth blip must land in the near-miss ledger"
