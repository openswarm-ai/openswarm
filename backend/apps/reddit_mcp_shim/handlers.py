"""Dispatch each MCP tool call to the Reddit client and format MCP content."""

import json

from backend.apps.reddit_mcp_shim import reddit_reads as reads
from backend.apps.reddit_mcp_shim import reddit_writes as writes
from backend.apps.reddit_mcp_shim.reddit_http import RedditError
from backend.apps.social_shims.session_source import SessionUnavailable


def mcp_ok(payload) -> dict:
    if isinstance(payload, str):
        return {"content": [{"type": "text", "text": payload}]}
    return {"content": [{"type": "text", "text": json.dumps(payload, indent=2, default=str)}]}


def mcp_err(text: str) -> dict:
    return {"content": [{"type": "text", "text": f"Error: {text}"}], "isError": True}


def handle_tool_call(name: str, args: dict) -> dict:
    try:
        return mcp_ok(p_dispatch(name, args))
    except SessionUnavailable as e:
        return mcp_err(str(e))
    except RedditError as e:
        return mcp_err(str(e))
    except Exception as e:
        return mcp_err(f"reddit shim error: {e!r}")


def p_dispatch(name: str, a: dict):
    if name == "reddit_whoami":
        return reads.whoami()
    if name == "reddit_browse":
        return reads.browse(a.get("subreddit", ""), a.get("sort", "hot"), a.get("time", ""),
                            p_lim(a.get("limit"), 25), a.get("after", ""))
    if name == "reddit_search":
        return reads.search(a.get("query", ""), a.get("subreddit", ""), a.get("sort", "relevance"),
                            a.get("time", "all"), p_lim(a.get("limit"), 25))
    if name == "reddit_get_post":
        return reads.get_post(a.get("target", ""), p_lim(a.get("comment_limit"), 50))
    if name == "reddit_get_user":
        return reads.get_user(a.get("username", ""), a.get("kind", "overview"), p_lim(a.get("limit"), 25))
    if name == "reddit_inbox":
        return reads.inbox(a.get("where", "inbox"), p_lim(a.get("limit"), 25))
    if name == "reddit_my_subreddits":
        return reads.my_subreddits(p_lim(a.get("limit"), 100))
    if name == "reddit_saved":
        return reads.saved(a.get("username", ""), p_lim(a.get("limit"), 25))
    if name == "reddit_submit":
        return writes.submit(a.get("subreddit", ""), a.get("title", ""), a.get("kind", "self"),
                             a.get("text", ""), a.get("url", ""), bool(a.get("nsfw")),
                             bool(a.get("spoiler")), a.get("send_replies", True))
    if name == "reddit_comment":
        return writes.comment(a.get("parent_id", ""), a.get("text", ""))
    if name == "reddit_edit":
        return writes.edit(a.get("thing_id", ""), a.get("text", ""))
    if name == "reddit_delete":
        return writes.delete(a.get("thing_id", ""))
    if name == "reddit_vote":
        return writes.vote(a.get("thing_id", ""), a.get("direction", ""))
    if name == "reddit_save":
        return writes.save(a.get("thing_id", ""), bool(a.get("unsave")))
    if name == "reddit_subscribe":
        return writes.subscribe(a.get("subreddit", ""), bool(a.get("unsubscribe")))
    if name == "reddit_send_message":
        return writes.compose(a.get("to", ""), a.get("subject", ""), a.get("text", ""))
    raise RedditError(f"Unknown tool: {name}")


def p_lim(v, default: int) -> int:
    try:
        return max(1, min(int(v), 100))
    except (TypeError, ValueError):
        return default
