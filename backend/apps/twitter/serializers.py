"""twikit object -> plain dict serializers.

Strict whitelist: we only pass through fields we know the LLM benefits
from seeing. Two reasons to keep this tight:

1. The LLM context is precious. Dumping every Twitter internal field
   (gibberish like `core.user_results.result.legacy.advertiser_account_type`)
   blows context for no gain.
2. Cache values are persisted to sqlite as JSON. We need every
   serialized value to be JSON-safe, and twikit objects aren't (they
   hold a back-reference to the Client).

Missing-field policy: `_safe()` swallows AttributeError and any other
exception twikit's property descriptors raise (they dereference into
`_data['legacy'][...]` and 404 on half-populated tweets), logging at
DEBUG and returning a default. We trade silent-degradation for not
surfacing drift, on the bet that the lifespan's smoke probe + the
gate's per-call exception handlers are the right place to catch real
twikit/X wire changes — the serializer just has to keep the cache JSON
viable.

`media_to_dict` handles the polymorphic Photo/Video/AnimatedGif subclass
case by reading the `type` attribute and only pulling the URLs each
subclass actually exposes. Streams (subclass of Video) reuse Video's
serializer.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)


def _safe(obj: object, attr: str, default: Any = None) -> Any:
    """Pull `attr` off `obj`, swallowing AttributeError + property errors.

    twikit's properties dereference into `_data['legacy'][...]` which
    sometimes 404s on freshly-fetched-but-half-populated tweets. Rather
    than mark the whole serialization as failed, log once and continue
    with the default.
    """
    try:
        return getattr(obj, attr, default)
    except Exception as e:  # noqa: BLE001 — twikit properties can raise *anything*
        logger.debug("serializer: %r raised on attr %s: %s", obj, attr, e)
        return default


def media_to_dict(media: object) -> dict:
    """Photo / Video / AnimatedGif / Stream → plain dict."""
    return {
        "id": _safe(media, "id"),
        "type": _safe(media, "type"),
        "url": _safe(media, "url") or _safe(media, "media_url"),
        # Photos expose `media_url`; videos expose `streams` (list of
        # variants). Serialize both possibilities, swallow whichever
        # doesn't apply.
        "alt_text": _safe(media, "alt_text"),
    }


def user_to_dict(user: object) -> dict:
    """twikit.User → JSON-safe dict, whitelisted fields only."""
    return {
        "id": _safe(user, "id"),
        "handle": _safe(user, "screen_name"),
        "name": _safe(user, "name"),
        "description": _safe(user, "description"),
        "location": _safe(user, "location"),
        "url": _safe(user, "url"),
        "profile_image_url": _safe(user, "profile_image_url"),
        "profile_banner_url": _safe(user, "profile_banner_url"),
        "created_at": _safe(user, "created_at"),
        "is_blue_verified": _safe(user, "is_blue_verified"),
        "verified": _safe(user, "verified"),
        "followers_count": _safe(user, "followers_count"),
        "following_count": _safe(user, "following_count"),
        "statuses_count": _safe(user, "statuses_count"),
        "media_count": _safe(user, "media_count"),
        "listed_count": _safe(user, "listed_count"),
        "favourites_count": _safe(user, "favourites_count"),
        "pinned_tweet_ids": _safe(user, "pinned_tweet_ids") or [],
    }


def tweet_to_dict(tweet: object, *, include_replies: bool = False) -> dict:
    """twikit.Tweet → JSON-safe dict, recursively flattening quotes.

    `include_replies` is opt-in because the recursive .replies attribute
    can be a `Result[Tweet]` of arbitrary length. We materialize the
    current page only (no auto-pagination).
    """
    user = _safe(tweet, "user")
    quote = _safe(tweet, "quote")
    retweeted = _safe(tweet, "retweeted_tweet")
    media_list = _safe(tweet, "media") or []

    out: dict = {
        "id": _safe(tweet, "id"),
        "created_at": _safe(tweet, "created_at"),
        "text": _safe(tweet, "text"),
        "lang": _safe(tweet, "lang"),
        "in_reply_to": _safe(tweet, "in_reply_to"),
        "is_quote_status": _safe(tweet, "is_quote_status"),
        "possibly_sensitive": _safe(tweet, "possibly_sensitive"),
        "view_count": _safe(tweet, "view_count"),
        "reply_count": _safe(tweet, "reply_count"),
        "favorite_count": _safe(tweet, "favorite_count"),
        "retweet_count": _safe(tweet, "retweet_count"),
        "quote_count": _safe(tweet, "quote_count"),
        "bookmark_count": _safe(tweet, "bookmark_count"),
        "hashtags": _safe(tweet, "hashtags") or [],
        "urls": _safe(tweet, "urls") or [],
        "media": [media_to_dict(m) for m in media_list],
        "user": user_to_dict(user) if user is not None else None,
        # Nested tweets recurse but don't drill into THEIR replies/
        # quote/retweet to keep payload sizes bounded.
        "quote": _shallow_tweet_to_dict(quote) if quote is not None else None,
        "retweeted_tweet": _shallow_tweet_to_dict(retweeted) if retweeted is not None else None,
    }

    if include_replies:
        replies = _safe(tweet, "replies")
        if replies is not None:
            out["replies"] = result_to_dict(replies, tweet_to_dict)

    return out


def _shallow_tweet_to_dict(tweet: object) -> dict:
    """Tweet → dict but without recursing further into quote/retweet chains."""
    user = _safe(tweet, "user")
    return {
        "id": _safe(tweet, "id"),
        "created_at": _safe(tweet, "created_at"),
        "text": _safe(tweet, "text"),
        "user": user_to_dict(user) if user is not None else None,
        "reply_count": _safe(tweet, "reply_count"),
        "favorite_count": _safe(tweet, "favorite_count"),
        "retweet_count": _safe(tweet, "retweet_count"),
    }


def response_to_dict(resp: object) -> dict:
    """Minimal serializer for twikit calls that return `httpx.Response`.

    `favorite_tweet`, `unfavorite_tweet`, `retweet`, `delete_retweet`,
    `bookmark_tweet`, `delete_bookmark`, and `delete_tweet` all return
    a bare httpx Response with no useful body for the agent. Surface a
    {ok, status} pair so the MCP shim and UI can show a clean
    confirmation. The route tail (`_gate_result_to_response`) already
    handles error outcomes — this serializer only runs on success.

    Tolerates duck-typed mocks in tests by falling back to (True, 200)
    when the attributes aren't present, so the happy-path assertions
    don't have to construct an httpx.Response.
    """
    return {
        "ok": bool(getattr(resp, "is_success", True)),
        "status": int(getattr(resp, "status_code", 200)),
    }


def message_to_dict(msg: object) -> dict:
    """twikit.Message / twikit.GroupMessage → JSON-safe dict.

    Both 1:1 `Message` and `GroupMessage` share the same field set
    (`id`, `time`, `text`, `sender_id`, `recipient_id`, `attachment`);
    `GroupMessage` adds `group_id`. We pull `group_id` unconditionally
    — `_safe` returns None for 1:1 messages that don't carry it, which
    is the right shape for the caller (None signals "1:1 DM").

    `time` is twikit's own epoch-string field (not `created_at`); the
    caller is responsible for parsing if it wants a datetime.

    `attachment` is a free-form dict containing media metadata. We
    pass it through verbatim — it's already JSON-safe coming out of
    twikit's parser.
    """
    return {
        "id": _safe(msg, "id"),
        "time": _safe(msg, "time"),
        "text": _safe(msg, "text"),
        "sender_id": _safe(msg, "sender_id"),
        "recipient_id": _safe(msg, "recipient_id"),
        "attachment": _safe(msg, "attachment"),
        "group_id": _safe(msg, "group_id"),
    }


def group_to_dict(group: object) -> dict:
    """twikit.Group → JSON-safe dict.

    Members are serialized through `user_to_dict` to keep the LLM
    payload consistent with every other place we surface User objects.
    """
    members = _safe(group, "members", default=[]) or []
    return {
        "id": _safe(group, "id"),
        "name": _safe(group, "name"),
        "members": [user_to_dict(m) for m in members],
    }


def result_to_dict(result: object, item_serializer) -> dict:
    """twikit.utils.Result → {items, next_cursor, previous_cursor}.

    Result is iterable (yields items in this page). It also carries
    cursor strings the caller threads back through subsequent calls
    for pagination. We don't auto-fetch the next page — that's the
    caller's job, and counts against the rate-limit budget separately.

    Tolerates `result is None` (the previous shape — `for item in None`
    then `for item in result or []` — handled it accidentally, but the
    TypeError fallback was a no-op since the second loop also raised
    on None).
    """
    if result is None:
        return {"items": [], "next_cursor": None, "previous_cursor": None}

    items = []
    try:
        for item in result:
            items.append(item_serializer(item))
    except TypeError:
        # Some twikit endpoints return bare lists rather than Result
        # instances; iter() on a list works fine, so a TypeError here
        # really means "this object isn't iterable at all" — log and
        # treat as empty.
        logger.debug("serializer: result_to_dict got non-iterable %r", result)
        return {
            "items": [],
            "next_cursor": _safe(result, "next_cursor"),
            "previous_cursor": _safe(result, "previous_cursor"),
        }

    return {
        "items": items,
        "next_cursor": _safe(result, "next_cursor"),
        "previous_cursor": _safe(result, "previous_cursor"),
    }
