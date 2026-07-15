"""Read operations for X, driven through the user's own logged-in x.com card.

X blocks pure-HTTP reads (it signs every request with browser-JS we can't forge), so we
navigate the real card to the right URL, let it render, and scrape the DOM via the
perform_action bridge. Free, undetectable, and immune to query-id/signature drift.
"""

import re
import urllib.parse
from typing import Any, Dict, List

from backend.apps.social_shims.browser_action import last_json, perform
from backend.apps.x_mcp_shim.x_dom import profile_js, scrape_tweets_js, whoami_js

DOMAIN = "x.com"
SEARCH_F = {"latest": "live", "people": "user", "media": "media"}


def tweet_id_of(target: str) -> str:
    m = re.search(r"(\d{5,})", target or "")
    return m.group(1) if m else (target or "")


def p_tweets(url: str, cap: int, wait_ms: int = 3000) -> List[Dict[str, Any]]:
    res = perform(DOMAIN, [
        {"op": "navigate", "url": url},
        {"op": "wait", "ms": wait_ms},
        {"op": "evaluate", "expression": scrape_tweets_js(cap)},
    ])
    out = last_json(res)
    return out if isinstance(out, list) else []


def whoami() -> Dict[str, Any]:
    res = perform(DOMAIN, [
        {"op": "navigate", "url": "https://x.com/home"},
        {"op": "wait", "ms": 2200},
        {"op": "evaluate", "expression": whoami_js()},
    ])
    return last_json(res)


def search(query: str, product: str, count: int) -> Dict[str, Any]:
    q = urllib.parse.quote(query)
    f = SEARCH_F.get((product or "top").lower())
    url = f"https://x.com/search?q={q}&src=typed_query" + (f"&f={f}" if f else "")
    tweets = p_tweets(url, count)
    return {"query": query, "tweets": tweets, "count": len(tweets)}


def timeline(kind: str, count: int) -> Dict[str, Any]:
    tweets = p_tweets("https://x.com/home", count)
    return {"kind": kind, "tweets": tweets, "count": len(tweets)}


def user_tweets(username: str, count: int) -> Dict[str, Any]:
    h = username.lstrip("@")
    tweets = p_tweets(f"https://x.com/{h}", count)
    return {"username": h, "tweets": tweets, "count": len(tweets)}


def get_tweet(target: str, replies_limit: int) -> Dict[str, Any]:
    url = target if str(target).startswith("http") else f"https://x.com/i/status/{tweet_id_of(target)}"
    tweets = p_tweets(url, replies_limit + 1)
    return {"tweet": tweets[0] if tweets else {}, "replies": tweets[1:replies_limit + 1]}


def get_user(username: str) -> Dict[str, Any]:
    h = username.lstrip("@")
    res = perform(DOMAIN, [
        {"op": "navigate", "url": f"https://x.com/{h}"},
        {"op": "wait", "ms": 2800},
        {"op": "evaluate", "expression": profile_js()},
    ])
    return last_json(res)


def bookmarks(count: int) -> Dict[str, Any]:
    tweets = p_tweets("https://x.com/i/bookmarks", count)
    return {"tweets": tweets, "count": len(tweets)}


def notifications(count: int) -> Dict[str, Any]:
    tweets = p_tweets("https://x.com/notifications", count)
    return {"notifications": tweets, "count": len(tweets)}
