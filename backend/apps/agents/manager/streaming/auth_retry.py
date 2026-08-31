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
    """Queue the one hidden retry on a new CLI process that resumes the same transcript (the
    process is what holds the stale token; the conversation is fine). False = budget spent or a
    continuation is already pending, and the caller should show the honest banner instead.

    delay_s: codex tokens ROTATE on a 1-2 minute cadence; an instant retry lands inside the same
    rotation window, burns the one-shot budget, and the user then gets a banner for a condition
    that would have healed itself (field screenshot, 2026-08-19). Callers pass ~75s for
    rotation-shaped failures so the retry fires after the window closes."""
    if session.auth_retry_used or session.pending_continuation:
        return False
    session.auth_retry_used = True
    session.needs_respawn = True
    session.pending_continuation = True
    session.pending_continuation_prompt = AUTH_RETRY_PROMPT
    session.pending_continuation_delay_s = max(0, delay_s)
    return True


TRANSIENT_RETRY_PROMPT = (
    "The model provider returned a temporary error instead of an answer on your last step, and it "
    "has now cleared. Redo that one step, then carry on where you left off."
)

# Two is the whole budget: looping past it trades a visible stop for an invisible one, which is worse.
TRANSIENT_RETRY_MAX = 2


@typechecked
def try_transient_self_heal(session: AgentSession, delay_s: int = 0) -> bool:
    """Queue a hidden retry for a provider error that waiting can actually fix.

    Separate budget from the auth one-shot on purpose: these arrive by the same door (assistant
    TEXT, no exception) but for opposite reasons, and sharing a counter would let a rate limit
    consume the retry an expired token needs moments later.

    No fresh session here, unlike the auth path. A rate limit is the provider's verdict on the
    ACCOUNT, so rebuilding the CLI costs a respawn and changes nothing (there is a standing test
    that a 429 must not respawn the CLI); the connection case is handled by simply waiting.
    """
    if session.pending_continuation:
        return False
    if session.transient_retry_count >= TRANSIENT_RETRY_MAX:
        return False
    session.transient_retry_count += 1
    session.pending_continuation = True
    session.pending_continuation_prompt = TRANSIENT_RETRY_PROMPT
    session.pending_continuation_delay_s = max(0, delay_s)
    return True


STALE_TOOL_SCHEMA_RETRY_PROMPT = (
    "Your tool definitions were stale on that last step and the connection has been rebuilt with "
    "fresh ones. Redo that one step, then carry on where you left off."
)


@typechecked
def try_stale_tool_schema_self_heal(session: AgentSession) -> bool:
    """One respawn for the deferred-tool 400 (ENG-394): the CLI re-registers its tools on a new
    process, so the same turn goes through instead of dying on top of the work it already did.

    Its own budget, like the auth one-shot and for the same reason: this and an expiring token
    arrive by different doors moments apart, and a shared counter would let one eat the other's
    retry. One is the whole budget; a second identical 400 means respawning is not the cure and the
    user is owed the honest card rather than a loop.
    """
    if session.stale_tool_schema_retry_used or session.pending_continuation:
        return False
    session.stale_tool_schema_retry_used = True
    session.needs_respawn = True
    session.pending_continuation = True
    session.pending_continuation_prompt = STALE_TOOL_SCHEMA_RETRY_PROMPT
    session.pending_continuation_delay_s = 0
    return True
