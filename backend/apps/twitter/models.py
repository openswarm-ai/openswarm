"""Pydantic types for the Twitter SubApp.

`TwitterAccount` is the public-facing record (serialized via API).
Credentials never live in this model — passwords are accepted in
`LoginRequest`, used once for `client.login()`, then discarded; cookies
live on disk only.
"""

from __future__ import annotations

import time
from typing import Literal, Optional
from uuid import uuid4

from pydantic import BaseModel, Field, model_validator


# The state machine documented in the plan ("Account lifecycle" section).
AccountState = Literal["active", "locked", "needs_relogin", "suspended"]
AccountRole = Literal["primary", "read_only"]


class TwitterAccount(BaseModel):
    """Public account record. Mirrors what's stored in accounts.json
    minus secrets (no password ever; cookies live in a separate file).
    """

    id: str = Field(default_factory=lambda: uuid4().hex)
    label: str = ""
    handle: Optional[str] = None  # @screen_name, set after first login
    role: AccountRole = "primary"
    state: AccountState = "active"
    trust_multiplier: float = 0.4   # see Rate-limit semantics in the plan
    proxy: Optional[str] = None
    created_at: float = Field(default_factory=time.time)
    last_verified_at: float = 0.0
    last_error: Optional[str] = None


class LoginRequest(BaseModel):
    """Inbound login payload.

    twikit's `client.login()` is flexible about which of auth_info_1 /
    auth_info_2 is the username/email/phone — we just forward both. The
    password is here and only here; it's used to call `client.login()`
    and then dropped on the floor (never written to disk, never logged).
    """

    auth_info_1: str
    auth_info_2: Optional[str] = None
    password: str
    totp_secret: Optional[str] = None
    label: Optional[str] = None
    role: AccountRole = "primary"


class CookieImportRequest(BaseModel):
    """Inbound body for `POST /accounts/import`.

    Carries the two cookies that x.com's GraphQL endpoints actually
    cross-check (``auth_token`` = session secret, ``ct0`` = CSRF token
    paired with the ``x-csrf-token`` header twikit sends). Mirrors the
    CLI signature of `import_cookies.py` so the on-disk format and the
    HTTP path stay interchangeable.

    `id` is the re-login hook: if it matches an existing pool entry
    the cookies are overwritten in place and bucket state is preserved
    (`pool.add` handles the in-place swap). Otherwise a fresh uuid is
    minted. `handle` is a secondary dedupe path used when the UI knows
    the screen_name (e.g. from a previous verify) but not the account id.
    """

    auth_token: str = Field(min_length=1)
    ct0: str = Field(min_length=1)
    label: Optional[str] = None
    handle: Optional[str] = None
    role: AccountRole = "primary"
    id: Optional[str] = None

    @model_validator(mode="after")
    def _strip_and_check(self) -> "CookieImportRequest":
        self.auth_token = self.auth_token.strip()
        self.ct0 = self.ct0.strip()
        if not self.auth_token or not self.ct0:
            raise ValueError("auth_token and ct0 must be non-empty after stripping")
        return self


class TrustUpdateRequest(BaseModel):
    """PATCH /accounts/{id} body — currently just trust_multiplier.

    Constrained to [0, 1]. Upper bound prevents a stray decimal from
    multiplying the budget by 10 and tripping a wave of 429s; lower
    bound of 0 (inclusive) lets the operator pause an account
    in-place without deleting it ("dial trust to 0 while debugging
    why this account is hitting locks"). Bucket math treats
    capacity=0 as "never refill," so a paused account stays in the
    pool, keeps its cookies, but loses its turn in `pick()`.
    """

    trust_multiplier: float

    @model_validator(mode="after")
    def _check_range(self) -> "TrustUpdateRequest":
        if not (0.0 <= self.trust_multiplier <= 1.0):
            raise ValueError("trust_multiplier must be in [0, 1]")
        return self


class BucketSnapshot(BaseModel):
    """One bucket's current state, for /health."""

    endpoint: str
    capacity: int
    tokens: float
    locked_until: float
    seconds_until_available: float


class AccountHealth(BaseModel):
    """Output of GET /accounts/{id}/health.

    Served from in-memory pool state — does NOT call twikit, so health
    polling can be aggressive without burning rate budget.
    """

    id: str
    label: str
    handle: Optional[str]
    state: AccountState
    role: AccountRole
    trust_multiplier: float
    last_verified_at: float
    last_error: Optional[str]
    recent_429_count: int = 0
    buckets: list[BucketSnapshot] = []


# --- Tool request schemas. Pydantic enforces enums + bounds before
# --- anything hits twikit; saves us defensive checks in the route.

TweetProduct = Literal["Top", "Latest", "Media"]
UserTweetType = Literal["Tweets", "Replies", "Media", "Likes"]


class SearchRequest(BaseModel):
    q: str
    product: TweetProduct = "Latest"
    count: int = Field(default=20, ge=1, le=50)
    cursor: Optional[str] = None


class UserLookupRequest(BaseModel):
    """One of handle or user_id must be provided, not both."""

    handle: Optional[str] = None
    user_id: Optional[str] = None

    @model_validator(mode="after")
    def _exactly_one(self) -> "UserLookupRequest":
        if bool(self.handle) == bool(self.user_id):
            raise ValueError("specify exactly one of: handle, user_id")
        return self


class UserTweetsRequest(BaseModel):
    user_id: str
    type: UserTweetType = "Tweets"
    count: int = Field(default=20, ge=1, le=50)
    cursor: Optional[str] = None


class TweetLookupRequest(BaseModel):
    tweet_id: str


class TweetRepliesRequest(BaseModel):
    tweet_id: str
    cursor: Optional[str] = None
