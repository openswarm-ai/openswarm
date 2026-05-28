# In-memory store for pending OAuth flows (state -> {provider, code_verifier, redirect_uri})
_pending_oauth: dict[str, dict] = {}
# Recently-completed OAuth states so the /api/subscriptions/callback handler
# can distinguish a legitimate duplicate callback (browser prefetch, refresh,
# or Google redirect retry after a slow first response) from a truly stale
# request. Bounded FIFO, drops the oldest entries once it grows past
# _MAX_COMPLETED_OAUTH so it can't leak memory.
_completed_oauth: list[str] = []
_MAX_COMPLETED_OAUTH = 64


def _mark_oauth_completed(state: str) -> None:
    if state in _completed_oauth:
        return
    _completed_oauth.append(state)
    # Trim head if we've outgrown the bound
    while len(_completed_oauth) > _MAX_COMPLETED_OAUTH:
        _completed_oauth.pop(0)
