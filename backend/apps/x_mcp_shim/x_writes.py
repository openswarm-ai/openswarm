"""Write operations for X, driven through the user's own logged-in x.com card.

Navigate the real card and click/type via the perform_action bridge, so X's own browser
generates the request signature we can't forge from HTTP. Targets are tweet URLs from the
read tools. tweet/reply/quote/like/retweet/follow are wired; DM stays a card-only action.
"""

from typing import Any, Dict

from backend.apps.social_shims.browser_action import BrowserActionError, last_json, perform
from backend.apps.x_mcp_shim.x_dom import (
    click_action_js,
    follow_js,
    open_reply_js,
    post_text_js,
    retweet_js,
)
from backend.apps.x_mcp_shim.x_reads import tweet_id_of

DOMAIN = "x.com"


def p_url(target: str) -> str:
    return target if str(target).startswith("http") else f"https://x.com/i/status/{tweet_id_of(target)}"


def tweet(text: str, reply_to: str, quote_id: str) -> Dict[str, Any]:
    if reply_to:
        steps = [
            {"op": "navigate", "url": p_url(reply_to)},
            {"op": "wait", "ms": 2800},
            {"op": "evaluate", "expression": open_reply_js()},
            {"op": "evaluate", "expression": post_text_js(text, "tweetButton")},
        ]
        return {"replied_to": reply_to, "result": last_json(perform(DOMAIN, steps))}
    body = text if not quote_id else f"{text} {p_url(quote_id)}".strip()
    steps = [
        {"op": "navigate", "url": "https://x.com/compose/post"},
        {"op": "wait", "ms": 2500},
        {"op": "evaluate", "expression": post_text_js(body, "tweetButton")},
    ]
    return {"posted": True, "quote": bool(quote_id), "result": last_json(perform(DOMAIN, steps))}


def like(target: str, unlike: bool) -> Dict[str, Any]:
    js = click_action_js(["unlike"] if unlike else ["like"], "unlike" if not unlike else "like", "unlike" if unlike else "like")
    steps = [{"op": "navigate", "url": p_url(target)}, {"op": "wait", "ms": 2600}, {"op": "evaluate", "expression": js}]
    return {"target": target, "liked": not unlike, "result": last_json(perform(DOMAIN, steps))}


def retweet(target: str, undo: bool) -> Dict[str, Any]:
    steps = [{"op": "navigate", "url": p_url(target)}, {"op": "wait", "ms": 2600}, {"op": "evaluate", "expression": retweet_js(undo)}]
    return {"target": target, "retweeted": not undo, "result": last_json(perform(DOMAIN, steps))}


def follow(username: str, unfollow: bool) -> Dict[str, Any]:
    h = username.lstrip("@")
    steps = [{"op": "navigate", "url": f"https://x.com/{h}"}, {"op": "wait", "ms": 2600}, {"op": "evaluate", "expression": follow_js(unfollow)}]
    return {"username": h, "following": not unfollow, "result": last_json(perform(DOMAIN, steps))}


def delete_tweet(target: str) -> Dict[str, Any]:
    raise BrowserActionError(
        f"Deleting a tweet needs the caret menu + a confirm dialog that's risky to click blind. "
        f"Open {p_url(target)} in your X card and delete it there."
    )


def send_dm(recipient: str, text: str) -> Dict[str, Any]:
    raise BrowserActionError(
        f"DMs aren't wired for browser-driving yet. Open https://x.com/messages in your X card to DM {recipient!r}."
    )


def bookmark(target: str, remove: bool) -> Dict[str, Any]:
    js = click_action_js(["removeBookmark"] if remove else ["bookmark"], "bookmark", "bookmark")
    steps = [{"op": "navigate", "url": p_url(target)}, {"op": "wait", "ms": 2600}, {"op": "evaluate", "expression": js}]
    return {"target": target, "bookmarked": not remove, "result": last_json(perform(DOMAIN, steps))}
