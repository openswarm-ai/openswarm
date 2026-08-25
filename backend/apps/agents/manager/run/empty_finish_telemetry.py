"""Telemetry for the silent-quit ladder, split out of empty_finish.py to keep that file to one job.

The two events answer different questions and must not be conflated: a NUDGE means we poked a mute
agent, which is the system working; an EXHAUSTION is the only one the user ever sees. Counting the
first and not the second is why "how often does the recovery fail" was unanswerable across 1,695
recorded nudges (ENG-399).
"""

import logging

from typeguard import typechecked

logger = logging.getLogger(__name__)


@typechecked
def report_nudge(session: object, session_id: str, input_tokens: int, tool_calls: int) -> None:
    """A silent quit is the hardest class to diagnose after the fact, so it carries the same
    envelope as a hard error: without breadcrumbs you cannot see what the turn was doing."""
    try:
        from backend.apps.service.client import submit_diagnostic
        from backend.apps.agents.core import flight_recorder as p_fr
        p_n = int(getattr(session, "empty_finish_nudges", 0) or 0)
        submit_diagnostic({
            "kind": "empty_finish_nudge",
            "session_id": session_id,
            "model": getattr(session, "model", None),
            "input_tokens": input_tokens,
            "compacted": bool(getattr(session, "needs_fresh_session", False)),
            "tool_calls": tool_calls,
            "nudge": p_n,
            "flight": p_fr.build_envelope(
                session_id, "empty_finish_nudge", "silent_quit",
                getattr(session, "model", None), "stream", p_n),
        })
    except Exception:
        logger.debug("submit_diagnostic empty_finish_nudge failed", exc_info=True)


@typechecked
def report_exhausted(session: object, session_id: str) -> None:
    """The ONE outcome the user actually sees, and it was never recorded.

    We counted 1,695 nudges on one install and zero outcomes, so "1,695 silent quits" read as alarm
    when most of it is the ladder working. Only this event means someone lost an answer.
    """
    try:
        from backend.apps.service.client import submit_diagnostic
        from backend.apps.agents.core import flight_recorder as p_fr
        from backend.apps.agents.manager.run.empty_finish import count_tool_calls, turn_showed_work
        p_work = turn_showed_work(session)
        p_sub = "showed_work" if p_work else "no_progress"
        p_n = int(getattr(session, "empty_finish_nudges", 0) or 0)
        submit_diagnostic({
            "kind": "empty_finish_exhausted",
            "subkind": p_sub,
            "session_id": session_id,
            "model": getattr(session, "model", None),
            "input_tokens": int((getattr(session, "tokens", None) or {}).get("input", 0) or 0),
            "tool_calls": count_tool_calls(session),
            "nudges_spent": p_n,
            "quits_this_session": int(getattr(session, "empty_finish_total", 0) or 0),
            "history_prefix_sent": getattr(session, "history_prefix_sent", None),
            "flight": p_fr.build_envelope(
                session_id, "empty_finish_exhausted", p_sub,
                getattr(session, "model", None), "stream", p_n),
        })
    except Exception:
        logger.debug("submit_diagnostic empty_finish_exhausted failed", exc_info=True)
