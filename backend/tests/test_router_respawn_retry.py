"""The router-respawn retry seam (task: a turn must survive the localhost router dying).

Live-proven separately: a SIGKILLed router revives in ~1s and the CLI itself rides out 12-58s
outages. This file pins the LAST wall, the TurnRunner branch that catches the CLI's give-up shape
("API Error: Unable to connect" arriving as an error ResultMessage) and resumes instead of raising
straight to the error card, the way session 345a05eb died on 2026-08-06."""

import inspect

from backend.apps.agents.core.error_classify import is_router_unreachable_error
from backend.apps.agents.manager.run import TurnRunner


def test_turn_result_error_consults_the_router_classifier_before_raising():
    src = inspect.getsource(TurnRunner)
    handler = src.split("except TurnResultError", 1)[1]
    body = handler.split("except Exception as e", 1)[0]
    assert "is_router_unreachable_error" in body, "the router check must live on the TurnResultError path"
    assert body.index("is_router_unreachable_error") < body.index("raise"), "classify BEFORE the unconditional raise"


def test_the_retry_re_ensures_the_router_and_resumes_the_same_conversation():
    src = inspect.getsource(TurnRunner)
    body = src.split("except TurnResultError", 1)[1].split("except Exception as e", 1)[0]
    assert "ensure_running" in body, "the retry must actively revive the router, not just wait"
    assert 'options_kwargs["resume"]' in body, "the retry must resume the CLI conversation"
    assert "continue" in body


def test_the_retry_is_capped_so_a_dead_router_still_surfaces():
    src = inspect.getsource(TurnRunner)
    body = src.split("except TurnResultError", 1)[1].split("except Exception as e", 1)[0]
    assert "p_router_retry_attempt < 2" in body, "two attempts, then the honest error card"


def test_the_exact_live_incident_text_qualifies():
    # Verbatim shape from session 345a05eb7ca5470d9585b98618e81002 (2026-08-06 17:38:05).
    assert is_router_unreachable_error(
        "The agent runtime reported this turn failed (error_during_execution). "
        "API Error: Unable to connect. Is the computer able to access the url?"
    )
