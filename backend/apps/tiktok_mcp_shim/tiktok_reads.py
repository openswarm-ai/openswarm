"""Read operations over tiktok.com's web /api surface.

Returns compact video/user/comment records (truncated captions). A defensive walker
pulls video items out of whatever envelope the endpoint uses (itemList, data[].item),
which survives TikTok's frequent response reshuffles. Reads are best-effort: TikTok's
signature gate may still reject them, in which case tiktok_http raises an actionable hint.
"""

from typing import Any, Dict, List, Optional

from backend.apps.tiktok_mcp_shim.tiktok_http import TikTokError, get

CAP = 800


def p_trunc(s: Optional[str]) -> str:
    s = s or ""
    return s if len(s) <= CAP else s[:CAP] + f"... [+{len(s) - CAP} chars]"


def p_item(d: Dict[str, Any]) -> Dict[str, Any]:
    author = d.get("author") or {}
    if not isinstance(author, dict):
        author = {"uniqueId": author}
    stats = d.get("stats") or d.get("statsV2") or {}
    vid = d.get("id") or d.get("aweme_id")
    handle = author.get("uniqueId")
    return {
        "id": vid,
        "desc": p_trunc(d.get("desc")),
        "author": handle,
        "author_name": author.get("nickname"),
        "likes": stats.get("diggCount"),
        "comments": stats.get("commentCount"),
        "plays": stats.get("playCount"),
        "shares": stats.get("shareCount"),
        "created": d.get("createTime"),
        "url": f"https://www.tiktok.com/@{handle}/video/{vid}" if handle and vid else None,
    }


def p_is_item(d: Any) -> bool:
    return isinstance(d, dict) and "desc" in d and "author" in d and ("id" in d or "aweme_id" in d)


def p_collect_items(node: Any, out: List[Dict[str, Any]], cap: int) -> None:
    if len(out) >= cap:
        return
    if p_is_item(node):
        t = p_item(node)
        if t.get("id") and not any(x["id"] == t["id"] for x in out):
            out.append(t)
        return
    if isinstance(node, dict):
        for v in node.values():
            p_collect_items(v, out, cap)
    elif isinstance(node, list):
        for v in node:
            p_collect_items(v, out, cap)


def p_items_out(resp: Any, cap: int) -> Dict[str, Any]:
    out: List[Dict[str, Any]] = []
    p_collect_items(resp, out, cap)
    cursor = resp.get("cursor") if isinstance(resp, dict) else None
    return {"videos": out, "cursor": cursor, "has_more": bool(resp.get("hasMore")) if isinstance(resp, dict) else None}


def get_user(username: str) -> Dict[str, Any]:
    resp = get("user/detail/", {"uniqueId": username.lstrip("@")})
    info = (resp or {}).get("userInfo", {})
    user = info.get("user", {})
    stats = info.get("stats", {})
    return {
        "id": user.get("id"),
        "sec_uid": user.get("secUid"),
        "username": user.get("uniqueId"),
        "nickname": user.get("nickname"),
        "bio": p_trunc(user.get("signature")),
        "followers": stats.get("followerCount"),
        "following": stats.get("followingCount"),
        "likes": stats.get("heartCount"),
        "videos": stats.get("videoCount"),
        "verified": user.get("verified"),
    }


def feed(count: int) -> Dict[str, Any]:
    return p_items_out(get("recommend/item_list/", {"count": count, "from_page": "fyp"}), count)


def user_videos(username: str, count: int, cursor: str) -> Dict[str, Any]:
    sec_uid = get_user(username).get("sec_uid")
    if not sec_uid:
        raise TikTokError(f"Could not resolve @{username.lstrip('@')} to a secUid.")
    return p_items_out(get("post/item_list/", {"secUid": sec_uid, "count": count, "cursor": cursor or "0"}), count)


def get_video(video_id: str) -> Dict[str, Any]:
    resp = get("item/detail/", {"itemId": video_id})
    item = (resp or {}).get("itemInfo", {}).get("itemStruct", {})
    return p_item(item) if item else {"id": video_id, "note": "not found or signature-gated"}


def comments(video_id: str, count: int, cursor: str) -> Dict[str, Any]:
    resp = get("comment/list/", {"aweme_id": video_id, "count": count, "cursor": cursor or "0"})
    out = []
    for c in (resp or {}).get("comments", []) or []:
        u = c.get("user", {})
        out.append({
            "id": c.get("cid"),
            "text": p_trunc(c.get("text")),
            "author": u.get("unique_id") or u.get("uniqueId"),
            "likes": c.get("digg_count"),
            "created": c.get("create_time"),
        })
    return {"comments": out, "cursor": resp.get("cursor") if isinstance(resp, dict) else None}


def search(keyword: str, count: int) -> Dict[str, Any]:
    resp = get("search/general/full/", {"keyword": keyword, "offset": 0, "count": count, "from_page": "search"})
    return p_items_out(resp, count)
