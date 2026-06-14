# In-memory store for pending OAuth flows (state -> {provider, code_verifier, redirect_uri})
PENDING_OAUTH: dict[str, dict] = {}
# Recently-completed OAuth states so the /api/subscriptions/callback handler
# can distinguish a legitimate duplicate callback (browser prefetch, refresh,
# or Google redirect retry after a slow first response) from a truly stale
# request. Bounded FIFO, drops the oldest entries once it grows past
# _MAX_COMPLETED_OAUTH so it can't leak memory.
COMPLETED_OAUTH: list[str] = []
P_MAX_COMPLETED_OAUTH = 64


def mark_oauth_completed(state: str) -> None:
    if state in COMPLETED_OAUTH:
        return
    COMPLETED_OAUTH.append(state)
    # Trim head if we've outgrown the bound
    while len(COMPLETED_OAUTH) > P_MAX_COMPLETED_OAUTH:
        COMPLETED_OAUTH.pop(0)
