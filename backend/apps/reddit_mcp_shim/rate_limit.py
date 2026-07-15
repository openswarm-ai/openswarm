"""Reddit's per-action pacing config on top of the shared RateLimiter.

Reads are generous; writes (vote/comment/submit/compose) are deliberately slow so
the account never looks like a bot. The shared core owns the algorithm + honors
Reddit's X-Ratelimit-* headers and 429 backoff; this module just owns the bucket
sizes and exposes the module-level surface reddit_http already calls.
"""

from typing import Dict, Tuple

from backend.apps.social_shims.rate_limit_core import RateLimiter

# action -> (bucket_capacity, seconds_to_refill_one_token). Reads generous; writes deliberately slow.
BUCKETS: Dict[str, Tuple[float, float]] = {
    "read": (30.0, 1.0),
    "vote": (10.0, 3.0),
    "comment": (5.0, 12.0),
    "submit": (3.0, 60.0),
    "compose": (3.0, 30.0),
    "subscribe": (10.0, 3.0),
    "save": (15.0, 2.0),
}

p_limiter = RateLimiter(BUCKETS, min_gap_s=0.8, jitter_s=0.6)


def acquire(action: str) -> None:
    p_limiter.acquire(action)


def note_response(status: int, headers: Dict[str, str]) -> None:
    p_limiter.note_response(status, headers)


def bucket_for(action: str) -> str:
    return p_limiter.bucket_for(action)
