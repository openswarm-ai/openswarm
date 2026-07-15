"""Read operations over the authed oauth.reddit.com surface.

Returns compact, token-frugal records (truncated bodies) rather than Reddit's
raw firehose, so the agent sees what a human skims, not megabytes of JSON.
"""

import re

from backend.apps.reddit_mcp_shim.reddit_http import api

BODY_CAP = 2000


def p_trunc(s: str | None) -> str:
    s = s or ""
    return s if len(s) <= BODY_CAP else s[:BODY_CAP] + f"... [+{len(s) - BODY_CAP} chars]"


def p_post(d: dict) -> dict:
    return {
        "id": d.get("name"),
        "subreddit": d.get("subreddit"),
        "author": d.get("author"),
        "title": d.get("title"),
        "score": d.get("score"),
        "upvote_ratio": d.get("upvote_ratio"),
        "num_comments": d.get("num_comments"),
        "permalink": d.get("permalink"),
        "url": d.get("url"),
        "is_self": d.get("is_self"),
        "selftext": p_trunc(d.get("selftext")),
        "over_18": d.get("over_18"),
        "flair": d.get("link_flair_text"),
        "created_utc": d.get("created_utc"),
    }


def p_comment(d: dict) -> dict:
    return {
        "id": d.get("name"),
        "author": d.get("author"),
        "body": p_trunc(d.get("body")),
        "score": d.get("score"),
        "permalink": d.get("permalink"),
        "created_utc": d.get("created_utc"),
    }


def p_listing(resp: dict) -> dict:
    data = (resp or {}).get("data", {})
    items = []
    for ch in data.get("children", []):
        kind, cd = ch.get("kind"), ch.get("data", {})
        items.append(p_comment(cd) if kind == "t1" else p_post(cd))
    return {"items": items, "after": data.get("after")}


def whoami() -> dict:
    me = api("GET", "/api/me.json").get("data", {})
    return {
        "name": me.get("name"),
        "id": me.get("id"),
        "total_karma": me.get("total_karma"),
        "link_karma": me.get("link_karma"),
        "comment_karma": me.get("comment_karma"),
        "has_mail": me.get("has_mail"),
        "created_utc": me.get("created_utc"),
    }


def browse(subreddit: str, sort: str, t: str, limit: int, after: str) -> dict:
    sort = sort if sort in ("hot", "new", "top", "rising", "best", "controversial") else "hot"
    path = f"/r/{subreddit}/{sort}" if subreddit else f"/{sort}"
    return p_listing(api("GET", path, params={"limit": limit, "t": t or None, "after": after or None}))


def search(query: str, subreddit: str, sort: str, t: str, limit: int) -> dict:
    params = {"q": query, "limit": limit, "sort": sort or "relevance", "t": t or "all"}
    if subreddit:
        params["restrict_sr"] = 1
        path = f"/r/{subreddit}/search"
    else:
        path = "/search"
    return p_listing(api("GET", path, params=params))


def get_post(target: str, comment_limit: int) -> dict:
    article = target.split("t3_")[-1]
    m = re.search(r"comments/([a-z0-9]+)", target)
    if m:
        article = m.group(1)
    resp = api("GET", f"/comments/{article}", params={"limit": comment_limit, "depth": 6})
    post, comments = {}, {"items": []}
    if isinstance(resp, list) and len(resp) == 2:
        kids = resp[0].get("data", {}).get("children", [])
        if kids:
            post = p_post(kids[0].get("data", {}))
        comments = p_listing(resp[1])
    return {"post": post, "comments": comments["items"]}


def get_user(username: str, kind: str, limit: int) -> dict:
    about = api("GET", f"/user/{username}/about").get("data", {})
    where = kind if kind in ("submitted", "comments", "overview") else "overview"
    feed = p_listing(api("GET", f"/user/{username}/{where}", params={"limit": limit}))
    return {
        "name": about.get("name"),
        "link_karma": about.get("link_karma"),
        "comment_karma": about.get("comment_karma"),
        "created_utc": about.get("created_utc"),
        "is_mod": about.get("is_mod"),
        "items": feed["items"],
    }


def inbox(where: str, limit: int) -> dict:
    where = where if where in ("inbox", "unread", "sent", "messages", "mentions") else "inbox"
    resp = api("GET", f"/message/{where}", params={"limit": limit})
    data = (resp or {}).get("data", {})
    msgs = []
    for ch in data.get("children", []):
        cd = ch.get("data", {})
        msgs.append({
            "id": cd.get("name"),
            "author": cd.get("author"),
            "subject": cd.get("subject"),
            "body": p_trunc(cd.get("body")),
            "new": cd.get("new"),
            "context": cd.get("context"),
            "created_utc": cd.get("created_utc"),
        })
    return {"messages": msgs, "after": data.get("after")}


def my_subreddits(limit: int) -> dict:
    resp = api("GET", "/subreddits/mine/subscriber", params={"limit": limit})
    subs = [
        {"name": ch.get("data", {}).get("display_name"), "subscribers": ch.get("data", {}).get("subscribers")}
        for ch in (resp or {}).get("data", {}).get("children", [])
    ]
    return {"subreddits": subs}


def saved(username: str, limit: int) -> dict:
    user = username or whoami().get("name") or ""
    return p_listing(api("GET", f"/user/{user}/saved", params={"limit": limit}))
