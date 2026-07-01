"""Read operations over x.com's own /i/api GraphQL + v1.1/v2 surfaces.

Returns compact, token-frugal tweet/user records (truncated text) instead of X's
deeply-nested GraphQL firehose, so the agent sees what a human skims. The parsing
walks for `tweet_results` nodes anywhere in the tree, which survives X's frequent
timeline-shape reshuffles better than fixed index paths.
"""

import re
from typing import Any, Dict, List, Optional

from backend.apps.x_mcp_shim.x_http import XError, graphql, rest

TEXT_CAP = 1200


def p_trunc(s: Optional[str]) -> str:
    s = s or ""
    return s if len(s) <= TEXT_CAP else s[:TEXT_CAP] + f"... [+{len(s) - TEXT_CAP} chars]"


def tweet_id_of(target: str) -> str:
    """Accept a status URL, a t-prefixed id, or a bare id; return the numeric id."""
    m = re.search(r"(\d{5,})", target or "")
    return m.group(1) if m else (target or "")


def normalize_tweet(result: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(result, dict):
        return None
    if result.get("__typename") == "TweetWithVisibilityResults":
        result = result.get("tweet", result)
    legacy = result.get("legacy") or {}
    if not legacy and not result.get("rest_id"):
        return None
    user_result = ((result.get("core") or {}).get("user_results") or {}).get("result") or {}
    user_legacy = user_result.get("legacy") or {}
    user_core = user_result.get("core") or {}
    note = ((result.get("note_tweet") or {}).get("note_tweet_results") or {}).get("result") or {}
    text = note.get("text") or legacy.get("full_text") or ""
    return {
        "id": result.get("rest_id") or legacy.get("id_str"),
        "author": user_legacy.get("screen_name") or user_core.get("screen_name"),
        "name": user_legacy.get("name") or user_core.get("name"),
        "text": p_trunc(text),
        "likes": legacy.get("favorite_count"),
        "retweets": legacy.get("retweet_count"),
        "replies": legacy.get("reply_count"),
        "quotes": legacy.get("quote_count"),
        "views": (result.get("views") or {}).get("count"),
        "created_at": legacy.get("created_at"),
        "lang": legacy.get("lang"),
    }


def p_collect_tweets(node: Any, out: List[Dict[str, Any]], cap: int) -> None:
    if len(out) >= cap:
        return
    if isinstance(node, dict):
        tr = node.get("tweet_results")
        if isinstance(tr, dict) and isinstance(tr.get("result"), dict):
            t = normalize_tweet(tr["result"])
            if t and t.get("id") and not any(x["id"] == t["id"] for x in out):
                out.append(t)
        for v in node.values():
            p_collect_tweets(v, out, cap)
    elif isinstance(node, list):
        for v in node:
            p_collect_tweets(v, out, cap)


def p_cursor(node: Any) -> Optional[str]:
    found: List[str] = []

    def walk(n: Any) -> None:
        if found:
            return
        if isinstance(n, dict):
            if n.get("cursorType") == "Bottom" and n.get("value"):
                found.append(n["value"])
            for v in n.values():
                walk(v)
        elif isinstance(n, list):
            for v in n:
                walk(v)

    walk(node)
    return found[0] if found else None


def p_timeline_out(resp: Any, cap: int) -> Dict[str, Any]:
    items: List[Dict[str, Any]] = []
    p_collect_tweets(resp, items, cap)
    return {"tweets": items, "cursor": p_cursor(resp)}


def get_user(screen_name: str) -> Dict[str, Any]:
    resp = graphql("UserByScreenName", {"screen_name": screen_name.lstrip("@")})
    result = (((resp or {}).get("data") or {}).get("user") or {}).get("result") or {}
    legacy = result.get("legacy") or {}
    core = result.get("core") or {}
    return {
        "id": result.get("rest_id"),
        "screen_name": legacy.get("screen_name") or core.get("screen_name"),
        "name": legacy.get("name") or core.get("name"),
        "bio": p_trunc(legacy.get("description")),
        "followers": legacy.get("followers_count"),
        "following": legacy.get("friends_count"),
        "tweets": legacy.get("statuses_count"),
        "verified": result.get("is_blue_verified") or legacy.get("verified"),
        "created_at": legacy.get("created_at") or core.get("created_at"),
    }


def resolve_user_id(screen_name: str) -> str:
    uid = get_user(screen_name).get("id")
    if not uid:
        raise XError(f"Could not resolve @{screen_name.lstrip('@')} to a user id.")
    return str(uid)


def whoami() -> Dict[str, Any]:
    settings = rest("GET", "1.1/account/settings.json")
    screen = settings.get("screen_name", "")
    out: Dict[str, Any] = {"screen_name": screen}
    if screen:
        try:
            out["profile"] = get_user(screen)
        except XError:
            pass
    return out


def timeline(kind: str, count: int, cursor: str) -> Dict[str, Any]:
    op = "HomeLatestTimeline" if kind == "following" else "HomeTimeline"
    variables: Dict[str, Any] = {"count": count, "includePromotedContent": False,
                                 "latestControlAvailable": True, "withCommunity": True}
    if cursor:
        variables["cursor"] = cursor
    return p_timeline_out(graphql(op, variables, method="POST"), count)


def user_tweets(screen_name: str, count: int, cursor: str) -> Dict[str, Any]:
    uid = resolve_user_id(screen_name)
    variables: Dict[str, Any] = {"userId": uid, "count": count, "includePromotedContent": False,
                                 "withQuickPromoteEligibilityTweetFields": False, "withVoice": True,
                                 "withV2Timeline": True}
    if cursor:
        variables["cursor"] = cursor
    return p_timeline_out(graphql("UserTweets", variables), count)


def get_tweet(target: str, count: int) -> Dict[str, Any]:
    focal = tweet_id_of(target)
    variables: Dict[str, Any] = {"focalTweetId": focal, "with_rux_injections": False,
                                 "includePromotedContent": False, "withCommunity": True,
                                 "withQuickPromoteEligibilityTweetFields": True, "withBirdwatchNotes": True,
                                 "withVoice": True, "withV2Timeline": True}
    out = p_timeline_out(graphql("TweetDetail", variables), count + 1)
    tweets = out["tweets"]
    main = next((t for t in tweets if t["id"] == focal), tweets[0] if tweets else {})
    replies = [t for t in tweets if t.get("id") != main.get("id")]
    return {"tweet": main, "replies": replies[:count]}


def search(query: str, product: str, count: int, cursor: str) -> Dict[str, Any]:
    product = product.capitalize() if (product or "").lower() in ("top", "latest", "people", "media") else "Top"
    variables: Dict[str, Any] = {"rawQuery": query, "count": count, "querySource": "typed_query", "product": product}
    if cursor:
        variables["cursor"] = cursor
    return p_timeline_out(graphql("SearchTimeline", variables), count)


def bookmarks(count: int, cursor: str) -> Dict[str, Any]:
    variables: Dict[str, Any] = {"count": count, "includePromotedContent": False}
    if cursor:
        variables["cursor"] = cursor
    return p_timeline_out(graphql("Bookmarks", variables), count)


def notifications(count: int, cursor: str) -> Dict[str, Any]:
    resp = rest("GET", "2/notifications/all.json", params={"count": count, "cursor": cursor or None})
    notes = (resp or {}).get("globalObjects", {}).get("notifications", {})
    out = []
    for nid, n in list(notes.items())[:count]:
        out.append({
            "id": nid,
            "text": (n.get("message") or {}).get("text"),
            "timestamp_ms": n.get("timestampMs"),
        })
    return {"notifications": out}
