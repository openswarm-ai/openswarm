# In-memory store for pending OAuth flows (state -> {provider, code_verifier, redirect_uri})
pending_oauth: dict[str, dict] = {}
# Recently-completed OAuth states so the /api/subscriptions/callback handler
# can distinguish a legitimate duplicate callback (browser prefetch, refresh,
# or Google redirect retry after a slow first response) from a truly stale
# request. Bounded FIFO, drops the oldest entries once it grows past
# MAX_COMPLETED_OAUTH so it can't leak memory.
completed_oauth: list[str] = []
MAX_COMPLETED_OAUTH = 64


def mark_oauth_completed(state: str) -> None:
    if state in completed_oauth:
        return
    completed_oauth.append(state)
    # Trim head if we've outgrown the bound
    while len(completed_oauth) > MAX_COMPLETED_OAUTH:
        completed_oauth.pop(0)
