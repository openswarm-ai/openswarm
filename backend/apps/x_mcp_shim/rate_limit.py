"""X's per-action pacing config on top of the shared RateLimiter.

Reads are generous; posting is deliberately slow, likes/retweets moderate, follows
and DMs slow, so the account never bursts like a bot. The shared core owns the
algorithm + honors X's x-rate-limit-* headers and 429 backoff.
"""

from typing import Dict, Tuple

from backend.apps.social_shims.rate_limit_core import RateLimiter

# action -> (bucket_capacity, seconds_to_refill_one_token).
BUCKETS: Dict[str, Tuple[float, float]] = {
    "read": (30.0, 1.0),
    "tweet": (3.0, 60.0),
    "like": (20.0, 2.0),
    "follow": (8.0, 6.0),
    "dm": (5.0, 20.0),
}

p_limiter = RateLimiter(BUCKETS, min_gap_s=1.0, jitter_s=0.7)


def acquire(action: str) -> None:
    p_limiter.acquire(action)


def note_response(status: int, headers: Dict[str, str]) -> None:
    p_limiter.note_response(status, headers)


def bucket_for(action: str) -> str:
    return p_limiter.bucket_for(action)
