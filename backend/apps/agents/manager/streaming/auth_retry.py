"""One transparent retry when a subscription token expires mid-session (ENG-294).

The router surfaces an upstream 401 as assistant TEXT, and the old handling was a banner telling
the user to open Settings, find Models, click Reconnect, wait, and re-send: six actions to recover
from a token doing the one thing tokens always do. The router's own dispatcher usually refreshes
the credential within moments; what stays stale is OUR side, a pooled CLI still carrying the old
env. So the first expiry in an ask now rebuilds the session (fresh CLI, fresh router token) and
queues one hidden continuation to redo the failed step. A second expiry in the same ask means the
credential is genuinely dead, and the honest banner still fires; swallowing every 401 forever is
the failure mode this deliberately refuses.
"""
from typeguard import typechecked

from backend.apps.agents.core.models import AgentSession

AUTH_RETRY_PROMPT = (
    "The model provider returned an expired-credential error on your last step; the connection "
    "has been rebuilt with a refreshed token. Redo that one step, then carry on where you left off."
)


@typechecked
def try_auth_self_heal(session: AgentSession, delay_s: int = 0) -> bool:
    """Queue the one hidden retry on a fresh CLI. False = budget spent or a continuation is
    already pending, and the caller should show the honest banner instead.

    delay_s: codex tokens ROTATE on a 1-2 minute cadence; an instant retry lands inside the same
    rotation window, burns the one-shot budget, and the user then gets a banner for a condition
    that would have healed itself (field screenshot, 2026-08-19). Callers pass ~75s for
    rotation-shaped failures so the retry fires after the window closes."""
    if session.auth_retry_used or session.pending_continuation:
        return False
    session.auth_retry_used = True
    session.needs_fresh_session = True
    session.pending_continuation = True
    session.pending_continuation_prompt = AUTH_RETRY_PROMPT
    session.pending_continuation_delay_s = max(0, delay_s)
    return True
