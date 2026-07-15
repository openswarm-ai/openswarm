"""Dispatch each MCP tool call to the TikTok client and format MCP content."""

import json
from typing import Any, Dict

from backend.apps.social_shims.browser_action import BrowserActionError
from backend.apps.social_shims.session_source import SessionUnavailable
from backend.apps.tiktok_mcp_shim import tiktok_reads as reads
from backend.apps.tiktok_mcp_shim import tiktok_writes as writes
from backend.apps.tiktok_mcp_shim.tiktok_http import TikTokError


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
    except (TikTokError, BrowserActionError) as e:
        return mcp_err(str(e))
    except Exception as e:
        return mcp_err(f"tiktok shim error: {e!r}")


def p_dispatch(name: str, a: Dict[str, Any]) -> Any:
    if name == "tiktok_feed":
        return reads.feed(p_lim(a.get("count"), 20))
    if name == "tiktok_search":
        return reads.search(a.get("keyword", ""), p_lim(a.get("count"), 20))
    if name == "tiktok_get_user":
        return reads.get_user(a.get("username", ""))
    if name == "tiktok_user_videos":
        return reads.user_videos(a.get("username", ""), p_lim(a.get("count"), 20), a.get("cursor", ""))
    if name == "tiktok_get_video":
        return reads.get_video(a.get("video_id", ""))
    if name == "tiktok_comments":
        return reads.comments(a.get("video_id", ""), p_lim(a.get("count"), 20), a.get("cursor", ""))
    if name == "tiktok_like":
        return writes.like(a.get("video_url", ""), bool(a.get("unlike")))
    if name == "tiktok_favorite":
        return writes.favorite(a.get("video_url", ""), bool(a.get("remove")))
    if name == "tiktok_comment":
        return writes.comment(a.get("video_url", ""), a.get("text", ""))
    if name == "tiktok_follow":
        return writes.follow(a.get("username", ""), bool(a.get("unfollow")))
    if name == "tiktok_upload":
        return writes.upload(a.get("caption", ""), a.get("video_path", ""))
    raise TikTokError(f"Unknown tool: {name}")


def p_lim(v: Any, default: int) -> int:
    try:
        return max(1, min(int(v), 50))
    except (TypeError, ValueError):
        return default
