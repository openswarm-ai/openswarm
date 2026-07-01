"""Dispatch each MCP tool call to the X client and format MCP content."""

import json
from typing import Any, Dict

from backend.apps.social_shims.browser_action import BrowserActionError
from backend.apps.social_shims.session_source import SessionUnavailable
from backend.apps.x_mcp_shim import x_reads as reads
from backend.apps.x_mcp_shim import x_writes as writes


def mcp_ok(payload: Any) -> Dict[str, Any]:
    if isinstance(payload, str):
        return {"content": [{"type": "text", "text": payload}]}
    return {"content": [{"type": "text", "text": json.dumps(payload, indent=2, default=str)}]}


def mcp_err(text: str) -> Dict[str, Any]:
    return {"content": [{"type": "text", "text": f"Error: {text}"}], "isError": True}


def handle_tool_call(name: str, args: Dict[str, Any]) -> Dict[str, Any]:
    try:
        return mcp_ok(p_dispatch(name, args))
    except SessionUnavailable as e:
        return mcp_err(str(e))
    except BrowserActionError as e:
        return mcp_err(str(e))
    except Exception as e:
        return mcp_err(f"x shim error: {e!r}")


def p_dispatch(name: str, a: Dict[str, Any]) -> Any:
    if name == "x_whoami":
        return reads.whoami()
    if name == "x_timeline":
        return reads.timeline(a.get("kind", "foryou"), p_lim(a.get("count"), 20))
    if name == "x_user_tweets":
        return reads.user_tweets(a.get("username", ""), p_lim(a.get("count"), 20))
    if name == "x_get_tweet":
        return reads.get_tweet(a.get("target", ""), p_lim(a.get("replies_limit"), 30))
    if name == "x_search":
        return reads.search(a.get("query", ""), a.get("product", "top"), p_lim(a.get("count"), 20))
    if name == "x_get_user":
        return reads.get_user(a.get("username", ""))
    if name == "x_bookmarks":
        return reads.bookmarks(p_lim(a.get("count"), 20))
    if name == "x_notifications":
        return reads.notifications(p_lim(a.get("count"), 20))
    if name == "x_tweet":
        return writes.tweet(a.get("text", ""), a.get("reply_to", ""), a.get("quote_id", ""))
    if name == "x_delete_tweet":
        return writes.delete_tweet(a.get("target", ""))
    if name == "x_like":
        return writes.like(a.get("target", ""), bool(a.get("unlike")))
    if name == "x_retweet":
        return writes.retweet(a.get("target", ""), bool(a.get("undo")))
    if name == "x_bookmark":
        return writes.bookmark(a.get("target", ""), bool(a.get("remove")))
    if name == "x_follow":
        return writes.follow(a.get("username", ""), bool(a.get("unfollow")))
    if name == "x_send_dm":
        return writes.send_dm(a.get("recipient", ""), a.get("text", ""))
    raise BrowserActionError(f"Unknown tool: {name}")


def p_lim(v: Any, default: int) -> int:
    try:
        return max(1, min(int(v), 100))
    except (TypeError, ValueError):
        return default
