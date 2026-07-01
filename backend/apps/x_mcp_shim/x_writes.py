"""Write operations: everything a logged-in human does on X.

Tweets (with reply/quote), deletes, likes, retweets, bookmarks, follows, and DMs,
all via the user's borrowed session. Each call rides the rate limiter's write buckets.
"""

from typing import Any, Dict

from backend.apps.x_mcp_shim.x_http import graphql, rest
from backend.apps.x_mcp_shim.x_reads import normalize_tweet, resolve_user_id, tweet_id_of


def p_created_tweet(resp: Any) -> Dict[str, Any]:
    result = ((((resp or {}).get("data") or {}).get("create_tweet") or {})
              .get("tweet_results") or {}).get("result") or {}
    t = normalize_tweet(result) or {}
    return {"id": t.get("id"), "text": t.get("text")}


def tweet(text: str, reply_to: str, quote_id: str) -> Dict[str, Any]:
    variables: Dict[str, Any] = {
        "tweet_text": text,
        "dark_request": False,
        "media": {"media_entities": [], "possibly_sensitive": False},
        "semantic_annotation_ids": [],
    }
    if reply_to:
        variables["reply"] = {"in_reply_to_tweet_id": tweet_id_of(reply_to), "exclude_reply_user_ids": []}
    if quote_id:
        variables["attachment_url"] = f"https://x.com/i/status/{tweet_id_of(quote_id)}"
    return p_created_tweet(graphql("CreateTweet", variables, method="POST", action="tweet"))


def delete_tweet(target: str) -> Dict[str, Any]:
    tid = tweet_id_of(target)
    graphql("DeleteTweet", {"tweet_id": tid, "dark_request": False}, method="POST", action="tweet")
    return {"id": tid, "deleted": True}


def like(target: str, unlike: bool) -> Dict[str, Any]:
    tid = tweet_id_of(target)
    graphql("UnfavoriteTweet" if unlike else "FavoriteTweet", {"tweet_id": tid}, method="POST", action="like")
    return {"id": tid, "liked": not unlike}


def retweet(target: str, undo: bool) -> Dict[str, Any]:
    tid = tweet_id_of(target)
    if undo:
        graphql("DeleteRetweet", {"source_tweet_id": tid, "dark_request": False}, method="POST", action="like")
    else:
        graphql("CreateRetweet", {"tweet_id": tid, "dark_request": False}, method="POST", action="like")
    return {"id": tid, "retweeted": not undo}


def bookmark(target: str, remove: bool) -> Dict[str, Any]:
    tid = tweet_id_of(target)
    graphql("DeleteBookmark" if remove else "CreateBookmark", {"tweet_id": tid}, method="POST", action="like")
    return {"id": tid, "bookmarked": not remove}


def follow(screen_name: str, unfollow: bool) -> Dict[str, Any]:
    uid = resolve_user_id(screen_name)
    path = "1.1/friendships/destroy.json" if unfollow else "1.1/friendships/create.json"
    rest("POST", path, form={"user_id": uid}, action="follow")
    return {"screen_name": screen_name.lstrip("@"), "following": not unfollow}


def send_dm(recipient: str, text: str) -> Dict[str, Any]:
    rid = recipient if recipient.isdigit() else resolve_user_id(recipient)
    body = {"event": {"type": "message_create",
                      "message_create": {"target": {"recipient_id": rid},
                                         "message_data": {"text": text}}}}
    rest("POST", "1.1/dm/new2.json", json_body=body, action="dm")
    return {"to": recipient, "sent": True}
