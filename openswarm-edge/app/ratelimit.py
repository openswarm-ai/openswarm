"""Tiny in-memory per-key fixed-window rate limiter. Guards /__compute, /__llm,
and installer downloads so one visitor or scraper can't burn a creator's budget,
our CPU, or artifact egress. Best-effort and single-process: the cloud's budget
ledger is the hard backstop for metered calls."""
from __future__ import annotations

import time

# Hard ceiling on tracked keys so a flood of unique IPs can't grow the map without
# bound. Past it we evict the oldest-inserted keys in a batch, never the whole map:
# a dropped key just gets a fresh allowance, so the worst case is being briefly
# lenient to a few stale IPs, not wiping every live visitor's count at once.
_MAX_KEYS = 50_000
_EVICT_BATCH = _MAX_KEYS // 10


class RateLimiter:
    def __init__(self, limit: int, window_seconds: float):
        self.limit = limit
        self.window = window_seconds
        self._hits: dict[str, list[float]] = {}

    def allow(self, key: str) -> bool:
        now = time.time()
        if len(self._hits) > _MAX_KEYS:
            for stale in list(self._hits)[:_EVICT_BATCH]:
                self._hits.pop(stale, None)
        bucket = self._hits.get(key)
        if bucket is None:
            bucket = []
            self._hits[key] = bucket
        cutoff = now - self.window
        # Drop timestamps that fell out of the window.
        keep = 0
        for t in bucket:
            if t >= cutoff:
                break
            keep += 1
        if keep:
            del bucket[:keep]
        if len(bucket) >= self.limit:
            return False
        bucket.append(now)
        return True
