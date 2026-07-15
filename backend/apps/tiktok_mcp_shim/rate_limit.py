"""TikTok's per-action pacing config on top of the shared RateLimiter.

Reads are generous; likes/favorites moderate, comments/follows slow, so the account
never bursts like a bot. The shared core owns the algorithm + 429 backoff.
"""

from typing import Dict, Tuple

from backend.apps.social_shims.rate_limit_core import RateLimiter

# action -> (bucket_capacity, seconds_to_refill_one_token).
BUCKETS: Dict[str, Tuple[float, float]] = {
    "read": (25.0, 1.0),
    "like": (15.0, 3.0),
    "favorite": (15.0, 3.0),
    "comment": (5.0, 15.0),
    "follow": (8.0, 8.0),
}

p_limiter = RateLimiter(BUCKETS, min_gap_s=1.2, jitter_s=0.8)


def acquire(action: str) -> None:
    p_limiter.acquire(action)


def note_response(status: int, headers: Dict[str, str]) -> None:
    p_limiter.note_response(status, headers)


def bucket_for(action: str) -> str:
    return p_limiter.bucket_for(action)
