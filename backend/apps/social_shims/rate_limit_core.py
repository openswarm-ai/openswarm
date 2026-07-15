"""Shared human-pacing rate limiter for the social MCP shims.

One global minimum gap between any two requests (jittered), plus per-action token
buckets that cap bursty writes, plus honoring the site's X-Ratelimit-* headers and
429 backoff. Per-process, per-instance state; each shim builds its own limiter with
its own buckets. The whole point is to never look like a bot hammering an endpoint.

A plain class (not a pydantic model): it holds a lock and mutable runtime counters,
it isn't structured data.
"""

import random
import threading
import time
from typing import Dict, Optional, Tuple


class RateLimiter:
    """Token-bucket + global-gap + backoff pacer, configured per platform."""

    def __init__(
        self,
        buckets: Dict[str, Tuple[float, float]],
        min_gap_s: float = 0.8,
        jitter_s: float = 0.6,
    ) -> None:
        self.buckets = buckets
        self.min_gap_s = min_gap_s
        self.jitter_s = jitter_s
        self.lock = threading.Lock()
        self.tokens: Dict[str, Tuple[float, float]] = {}
        self.last_request_ts = 0.0
        self.backoff_until = 0.0

    def bucket_for(self, action: str) -> str:
        return action if action in self.buckets else "read"

    def acquire(self, action: str) -> None:
        """Block until it's polite to make a request of this action class."""
        bucket = self.bucket_for(action)
        cap, refill = self.buckets[bucket]
        while True:
            with self.lock:
                now = time.time()
                tokens, last = self.tokens.get(bucket, (cap, now))
                tokens = min(cap, tokens + (now - last) / refill)
                wait = max(0.0, self.backoff_until - now, (self.last_request_ts + self.min_gap_s) - now)
                if wait <= 0 and tokens >= 1.0:
                    self.tokens[bucket] = (tokens - 1.0, now)
                    self.last_request_ts = now
                    break
                if tokens < 1.0:
                    wait = max(wait, (1.0 - tokens) * refill)
                self.tokens[bucket] = (tokens, now)
            time.sleep(min(wait, 5.0) + random.uniform(0.0, self.jitter_s))

    def note_response(self, status: int, headers: Dict[str, str]) -> None:
        """Feed response signals back: a 429 or a drained X-Ratelimit means back off."""
        retry_after = 0.0
        if status == 429:
            retry_after = p_to_float(headers.get("retry-after")) or 5.0
        remaining = p_to_float(headers.get("x-ratelimit-remaining"))
        reset = p_to_float(headers.get("x-ratelimit-reset"))
        if remaining is not None and remaining <= 1.0 and reset:
            retry_after = max(retry_after, reset)
        if retry_after > 0:
            with self.lock:
                self.backoff_until = max(self.backoff_until, time.time() + retry_after)


def p_to_float(v: Optional[str]) -> Optional[float]:
    if v is None:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None
