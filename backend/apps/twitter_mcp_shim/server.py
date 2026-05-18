"""Stdio MCP shim for the Twitter SubApp.

Stdlib-only on purpose so the subprocess starts fast. Carries no
credentials: each MCP tool call is forwarded as a small HTTP request
to the local OpenSwarm backend (`OPENSWARM_BASE_URL`), authenticated
with our per-install token. The SubApp owns twikit, cookies, and rate-
limit state — this shim is pure protocol translation.

Write tools (`twitter_create_tweet`, `twitter_favorite_tweet`, ...)
go through the SubApp's `pick_writable` path, which only considers
accounts with `role=primary`. An operator can demote any account to
`read_only` via `PATCH /accounts/{id}` to keep it serving reads while
blocking writes through it.

Authentication. The bearer token comes from either:

1. `OPENSWARM_AUTH_TOKEN_FILE` — preferred. The shim re-reads this file
   on every `_call()` so a backend restart that rotates the token can't
   strand a long-lived shim subprocess in 401-land. The token is also
   cached in memory between calls; we only re-read when a 401 happens
   or after a small interval (5s), so the steady-state cost is one
   shared stat() per call, not a file open.
2. `OPENSWARM_AUTH_TOKEN` — fallback for callers that prefer the
   env-value pattern (matches `agent_manager`'s convention for other
   internal MCP servers).

Rate-limit response handling. The SubApp returns HTTP 429 with a JSON
body `{"retry_after_s": N}` when a tool call would exceed the gate's
block ceiling. We translate that into a structured MCP error content
("Rate limited; retry in N seconds") so the LLM backs off cleanly
instead of timing out and spawning parallel calls.
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

# ---------------------------------------------------------------------------
# Configuration (env vars set by tools_lib at spawn time)
# ---------------------------------------------------------------------------

BACKEND_BASE = (
    os.environ.get("OPENSWARM_BASE_URL")
    or f"http://127.0.0.1:{os.environ.get('OPENSWARM_PORT', '8324')}"
).rstrip("/")

AUTH_TOKEN_FILE = os.environ.get("OPENSWARM_AUTH_TOKEN_FILE", "")
_ENV_TOKEN = os.environ.get("OPENSWARM_AUTH_TOKEN", "")

# Cache the last-read token + read time so steady-state HTTP is fast.
# We re-read the file whenever the cached entry is older than this
# (cheap insurance against a rotation we missed).
_TOKEN_CACHE_TTL_S = 5.0
_token_cache: tuple[float, str] = (0.0, "")


def _read_token() -> str:
    """Return the current bearer token, preferring the file over env.

    Re-reading the file on every call would mean a syscall per request,
    but the in-memory cache trims that to one read per 5s. If the file
    isn't set, fall through to the env var (matches the rest of the
    codebase's convention).
    """
    global _token_cache
    now = time.time()
    if AUTH_TOKEN_FILE:
        cached_at, cached = _token_cache
        if cached and (now - cached_at) < _TOKEN_CACHE_TTL_S:
            return cached
        try:
            with open(AUTH_TOKEN_FILE, "r", encoding="utf-8") as f:
                tok = f.read().strip()
            if tok:
                _token_cache = (now, tok)
                return tok
        except OSError:
            # File missing or unreadable — fall back to env var so the
            # shim doesn't hard-fail just because the file rotated mid-
            # read.
            pass
    return _ENV_TOKEN


# ---------------------------------------------------------------------------
# Tool definitions (input schemas mirror the SubApp's route signatures)
# ---------------------------------------------------------------------------

TOOLS = [
    {
        "name": "twitter_search",
        "description": (
            "Search recent tweets matching a query. Returns a page of tweets and a "
            "`next_cursor` you can pass back to paginate. `product` selects ranking: "
            "'Latest' (recent), 'Top' (engagement-weighted), 'Media' (only tweets "
            "with images/video)."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "q": {"type": "string", "description": "Search query"},
                "product": {
                    "type": "string",
                    "enum": ["Top", "Latest", "Media"],
                    "default": "Latest",
                },
                "count": {"type": "integer", "minimum": 1, "maximum": 50, "default": 20},
                "cursor": {"type": "string"},
            },
            "required": ["q"],
        },
    },
    {
        "name": "twitter_get_user",
        "description": (
            "Look up a Twitter/X user by handle OR by numeric id. Provide exactly one "
            "of `handle` (without the @) or `user_id`."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "handle": {"type": "string", "description": "Screen name without @"},
                "user_id": {"type": "string", "description": "Numeric user ID"},
            },
        },
    },
    {
        "name": "twitter_get_user_tweets",
        "description": (
            "Page through a user's tweets. `type` selects which timeline: 'Tweets' "
            "(originals + retweets, default), 'Replies' (only replies), 'Media' "
            "(only tweets with media), 'Likes' (the user's likes)."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "user_id": {"type": "string", "description": "Numeric user ID"},
                "type": {
                    "type": "string",
                    "enum": ["Tweets", "Replies", "Media", "Likes"],
                    "default": "Tweets",
                },
                "count": {"type": "integer", "minimum": 1, "maximum": 50, "default": 20},
                "cursor": {"type": "string"},
            },
            "required": ["user_id"],
        },
    },
    {
        "name": "twitter_get_tweet",
        "description": "Fetch a single tweet by id, including its author + media + counts.",
        "inputSchema": {
            "type": "object",
            "properties": {"tweet_id": {"type": "string"}},
            "required": ["tweet_id"],
        },
    },
    {
        "name": "twitter_get_tweet_replies",
        "description": (
            "Fetch a page of replies to a tweet. `cursor` paginates through deeper "
            "reply pages — pass back the `next_cursor` from a prior call."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "tweet_id": {"type": "string"},
                "cursor": {"type": "string"},
            },
            "required": ["tweet_id"],
        },
    },
    # -----------------------------------------------------------------
    # Write tools. All of these mutate state on the authenticated
    # account. The agent harness should request user consent on the
    # first call per session (same gate it uses for other mutating MCP
    # tools); the backend's `pick_writable` adds a second line of
    # defense by refusing to use accounts the operator marked read_only.
    # -----------------------------------------------------------------
    {
        "name": "twitter_create_tweet",
        "description": (
            "Post a tweet. Use `reply_to=<tweet_id>` to reply, `attachment_url=<full "
            "tweet URL>` to quote-tweet. Both can be combined for a quote-reply. "
            "Returns the newly-created tweet."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "text": {"type": "string", "minLength": 1, "maxLength": 4000},
                "reply_to": {"type": "string", "description": "Tweet id to reply to (optional)"},
                "attachment_url": {"type": "string", "description": "Full URL of the tweet to quote (optional)"},
                "media_ids": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Pre-uploaded media ids (optional; upload route is separate)",
                },
            },
            "required": ["text"],
        },
    },
    {
        "name": "twitter_delete_tweet",
        "description": "Delete one of the authenticated account's own tweets by id.",
        "inputSchema": {
            "type": "object",
            "properties": {"tweet_id": {"type": "string"}},
            "required": ["tweet_id"],
        },
    },
    {
        "name": "twitter_favorite_tweet",
        "description": "Like (favorite) a tweet by id.",
        "inputSchema": {
            "type": "object",
            "properties": {"tweet_id": {"type": "string"}},
            "required": ["tweet_id"],
        },
    },
    {
        "name": "twitter_unfavorite_tweet",
        "description": "Unlike (unfavorite) a previously-liked tweet by id.",
        "inputSchema": {
            "type": "object",
            "properties": {"tweet_id": {"type": "string"}},
            "required": ["tweet_id"],
        },
    },
    {
        "name": "twitter_retweet",
        "description": "Retweet a tweet by id.",
        "inputSchema": {
            "type": "object",
            "properties": {"tweet_id": {"type": "string"}},
            "required": ["tweet_id"],
        },
    },
    {
        "name": "twitter_delete_retweet",
        "description": "Undo a retweet by tweet id.",
        "inputSchema": {
            "type": "object",
            "properties": {"tweet_id": {"type": "string"}},
            "required": ["tweet_id"],
        },
    },
    {
        "name": "twitter_bookmark_tweet",
        "description": "Bookmark a tweet by id.",
        "inputSchema": {
            "type": "object",
            "properties": {"tweet_id": {"type": "string"}},
            "required": ["tweet_id"],
        },
    },
    {
        "name": "twitter_delete_bookmark",
        "description": "Remove a tweet from bookmarks by id.",
        "inputSchema": {
            "type": "object",
            "properties": {"tweet_id": {"type": "string"}},
            "required": ["tweet_id"],
        },
    },
    {
        "name": "twitter_follow_user",
        "description": (
            "Follow a user by numeric id. Returns the followed user's profile so the "
            "agent doesn't need a separate lookup."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {"user_id": {"type": "string", "description": "Numeric user id"}},
            "required": ["user_id"],
        },
    },
    {
        "name": "twitter_unfollow_user",
        "description": "Unfollow a user by numeric id.",
        "inputSchema": {
            "type": "object",
            "properties": {"user_id": {"type": "string", "description": "Numeric user id"}},
            "required": ["user_id"],
        },
    },
    # -----------------------------------------------------------------
    # Direct messaging tools. Same write-gating discipline as the tweet
    # writes — every send/delete/reaction is `writable=True` server-side
    # and only runs against role=primary accounts.
    # -----------------------------------------------------------------
    {
        "name": "twitter_send_dm",
        "description": (
            "Send a 1:1 direct message to a user by numeric id. `media_id` and "
            "`reply_to` are optional. Returns the created message."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "user_id": {"type": "string", "description": "Recipient's numeric user id"},
                "text": {"type": "string", "minLength": 1, "maxLength": 10000},
                "media_id": {"type": "string", "description": "Pre-uploaded media id (optional)"},
                "reply_to": {"type": "string", "description": "Message id this DM replies to (optional)"},
            },
            "required": ["user_id", "text"],
        },
    },
    {
        "name": "twitter_get_dm_history",
        "description": (
            "Fetch a page of 1:1 DM history with a user. Pass back `max_id` (the "
            "oldest message id from a prior page) to load older messages."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "user_id": {"type": "string", "description": "Other user's numeric id"},
                "max_id": {"type": "string", "description": "Paginate older than this message id (optional)"},
            },
            "required": ["user_id"],
        },
    },
    {
        "name": "twitter_delete_dm",
        "description": "Delete one of the authenticated account's own DMs by message id.",
        "inputSchema": {
            "type": "object",
            "properties": {"message_id": {"type": "string"}},
            "required": ["message_id"],
        },
    },
    {
        "name": "twitter_add_dm_reaction",
        "description": (
            "Add an emoji reaction to a 1:1 DM. `partner_id` is the *other* user's "
            "numeric id (the conversation peer); the backend builds the "
            "conversation id internally."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "message_id": {"type": "string"},
                "partner_id": {"type": "string", "description": "Other user's numeric id"},
                "emoji": {"type": "string", "minLength": 1},
            },
            "required": ["message_id", "partner_id", "emoji"],
        },
    },
    {
        "name": "twitter_remove_dm_reaction",
        "description": "Remove an emoji reaction from a 1:1 DM.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "message_id": {"type": "string"},
                "partner_id": {"type": "string", "description": "Other user's numeric id"},
                "emoji": {"type": "string", "minLength": 1},
            },
            "required": ["message_id", "partner_id", "emoji"],
        },
    },
    {
        "name": "twitter_send_group_dm",
        "description": (
            "Send a DM into an existing group conversation. `media_id` and "
            "`reply_to` are optional. Returns the created message."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "group_id": {"type": "string"},
                "text": {"type": "string", "minLength": 1, "maxLength": 10000},
                "media_id": {"type": "string"},
                "reply_to": {"type": "string"},
            },
            "required": ["group_id", "text"],
        },
    },
    {
        "name": "twitter_get_group_dm_history",
        "description": "Page through a group conversation's message history.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "group_id": {"type": "string"},
                "max_id": {"type": "string", "description": "Paginate older than this message id (optional)"},
            },
            "required": ["group_id"],
        },
    },
    {
        "name": "twitter_get_group",
        "description": "Fetch a group conversation's metadata (name + members).",
        "inputSchema": {
            "type": "object",
            "properties": {"group_id": {"type": "string"}},
            "required": ["group_id"],
        },
    },
    {
        "name": "twitter_add_group_members",
        "description": "Add one or more users to a group conversation by numeric id.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "group_id": {"type": "string"},
                "user_ids": {
                    "type": "array",
                    "items": {"type": "string"},
                    "minItems": 1,
                },
            },
            "required": ["group_id", "user_ids"],
        },
    },
    {
        "name": "twitter_change_group_name",
        "description": "Rename a group conversation.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "group_id": {"type": "string"},
                "name": {"type": "string", "minLength": 1, "maxLength": 50},
            },
            "required": ["group_id", "name"],
        },
    },
]


# ---------------------------------------------------------------------------
# HTTP plumbing
# ---------------------------------------------------------------------------

def _call(
    method: str,
    path: str,
    *,
    query: dict | None = None,
    body: dict | None = None,
    timeout: float = 30.0,
) -> tuple[int, dict | str]:
    """Single HTTP hop to the Twitter SubApp.

    Returns (status_code, parsed_body_or_text). The shim's tool handlers
    interpret status codes directly:
      - 200: success
      - 429: rate-limited -> surface retry_after_s to the agent
      - 409: account is in a bad state (locked/needs_relogin/suspended)
      - 503: backend unreachable or no active account
      - others: surfaced verbatim as MCP errors

    On 401 we invalidate the token cache and retry exactly once. The
    cache TTL is 5s, so without this the shim would 401-loop for up to
    five seconds after a backend restart that rotated the bearer
    token. One retry covers the common case (rotation) without
    looping forever on a real auth failure.
    """
    return _call_with_retry(method, path, query=query, body=body, timeout=timeout, _retry_on_401=True)


def _call_with_retry(
    method: str,
    path: str,
    *,
    query: dict | None,
    body: dict | None,
    timeout: float,
    _retry_on_401: bool,
) -> tuple[int, dict | str]:
    global _token_cache

    token = _read_token()
    if not token:
        return 0, "OPENSWARM_AUTH_TOKEN missing — shim can't authenticate to backend"

    url = f"{BACKEND_BASE}{path}"
    if query:
        cleaned = {k: v for k, v in query.items() if v is not None and v != ""}
        if cleaned:
            url += "?" + urllib.parse.urlencode(cleaned)

    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
    }
    data: bytes | None = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode("utf-8")

    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            text = resp.read().decode("utf-8", errors="replace")
            try:
                return resp.status, json.loads(text) if text else {}
            except json.JSONDecodeError:
                return resp.status, text
    except urllib.error.HTTPError as e:
        if e.code == 401 and _retry_on_401:
            # Bust the in-memory cache so _read_token re-reads the
            # token file (which may have rotated). Then retry exactly
            # once — flag is dropped so an actually-bad token surfaces
            # as the 401 rather than looping.
            _token_cache = (0.0, "")
            return _call_with_retry(
                method, path,
                query=query, body=body, timeout=timeout,
                _retry_on_401=False,
            )
        text = ""
        try:
            text = e.read().decode("utf-8", errors="replace") if e.fp else ""
        except Exception:
            pass
        try:
            return e.code, json.loads(text) if text else {}
        except json.JSONDecodeError:
            return e.code, text or str(e)
    except urllib.error.URLError as e:
        return 0, f"Backend unreachable: {e.reason}"
    except Exception as e:
        return 0, f"Request failed: {e!r}"


# ---------------------------------------------------------------------------
# MCP response helpers
# ---------------------------------------------------------------------------

def _ok(payload) -> dict:
    if isinstance(payload, str):
        return {"content": [{"type": "text", "text": payload}]}
    return {"content": [{"type": "text", "text": json.dumps(payload, indent=2, default=str)}]}


def _err(text: str) -> dict:
    return {"content": [{"type": "text", "text": f"Error: {text}"}], "isError": True}


def _rate_limited(body: dict) -> dict:
    """Surface a 429 in MCP form so the LLM can back off cleanly.

    There's no structured retry-after in MCP, so we put the integer in
    the text. Most LLMs honor "Rate limited; retry in N seconds" by
    pausing or returning to the user.
    """
    retry = body.get("retry_after_s") if isinstance(body, dict) else None
    endpoint = body.get("endpoint") if isinstance(body, dict) else None
    if retry is None:
        return _err("Rate limited (no retry hint).")
    msg = f"Rate limited on {endpoint or 'twitter'}; retry in {int(retry)} seconds."
    return {"content": [{"type": "text", "text": msg}], "isError": True}


def _handle_response(status: int, body) -> dict:
    """Translate a backend HTTP response into an MCP tool result."""
    if status == 200:
        return _ok(body)
    if status == 429:
        return _rate_limited(body if isinstance(body, dict) else {})
    if status == 409:
        # Account is in a bad state (locked/needs_relogin/suspended).
        msg = (body.get("error") if isinstance(body, dict) else None) or "Account is unavailable"
        return _err(msg)
    if status == 503:
        msg = (body.get("error") if isinstance(body, dict) else None) or "Twitter backend not ready"
        return _err(msg)
    if status == 0:
        return _err(str(body))
    # Everything else: surface verbatim so we don't paper over real bugs.
    return _err(f"HTTP {status}: {body}")


# ---------------------------------------------------------------------------
# Tool dispatch
# ---------------------------------------------------------------------------

def handle_tool_call(name: str, args: dict) -> dict:
    if name == "twitter_search":
        q = str(args.get("q", "")).strip()
        if not q:
            return _err("Missing required argument: q")
        status, body = _call(
            "GET",
            "/api/twitter/search",
            query={
                "q": q,
                "product": args.get("product", "Latest"),
                "count": args.get("count", 20),
                "cursor": args.get("cursor"),
            },
        )
        return _handle_response(status, body)

    if name == "twitter_get_user":
        handle = str(args.get("handle", "")).strip().lstrip("@")
        user_id = str(args.get("user_id", "")).strip()
        if bool(handle) == bool(user_id):
            return _err("Specify exactly one of: handle, user_id")
        query = {"handle": handle} if handle else {"id": user_id}
        status, body = _call("GET", "/api/twitter/user", query=query)
        return _handle_response(status, body)

    if name == "twitter_get_user_tweets":
        user_id = str(args.get("user_id", "")).strip()
        if not user_id:
            return _err("Missing required argument: user_id")
        status, body = _call(
            "GET",
            f"/api/twitter/user/{urllib.parse.quote(user_id, safe='')}/tweets",
            query={
                "type": args.get("type", "Tweets"),
                "count": args.get("count", 20),
                "cursor": args.get("cursor"),
            },
        )
        return _handle_response(status, body)

    if name == "twitter_get_tweet":
        tweet_id = str(args.get("tweet_id", "")).strip()
        if not tweet_id:
            return _err("Missing required argument: tweet_id")
        status, body = _call("GET", f"/api/twitter/tweet/{urllib.parse.quote(tweet_id, safe='')}")
        return _handle_response(status, body)

    if name == "twitter_get_tweet_replies":
        tweet_id = str(args.get("tweet_id", "")).strip()
        if not tweet_id:
            return _err("Missing required argument: tweet_id")
        status, body = _call(
            "GET",
            f"/api/twitter/tweet/{urllib.parse.quote(tweet_id, safe='')}/replies",
            query={"cursor": args.get("cursor")},
        )
        return _handle_response(status, body)

    # ----- write tools ------------------------------------------------
    # Each write tool maps 1:1 onto a route under /api/twitter/tweets or
    # /api/twitter/users. The backend gate handles role checks (writable=
    # True -> pick_writable), rate-limit budgets, and 429 surfacing.

    if name == "twitter_create_tweet":
        text = str(args.get("text", "")).strip()
        if not text:
            return _err("Missing required argument: text")
        body_payload: dict = {"text": text}
        if args.get("reply_to"):
            body_payload["reply_to"] = str(args["reply_to"])
        if args.get("attachment_url"):
            body_payload["attachment_url"] = str(args["attachment_url"])
        media_ids = args.get("media_ids")
        if isinstance(media_ids, list) and media_ids:
            body_payload["media_ids"] = [str(m) for m in media_ids]
        status, body = _call("POST", "/api/twitter/tweets", body=body_payload)
        return _handle_response(status, body)

    if name == "twitter_delete_tweet":
        tweet_id = str(args.get("tweet_id", "")).strip()
        if not tweet_id:
            return _err("Missing required argument: tweet_id")
        status, body = _call(
            "DELETE",
            f"/api/twitter/tweets/{urllib.parse.quote(tweet_id, safe='')}",
        )
        return _handle_response(status, body)

    if name == "twitter_favorite_tweet":
        tweet_id = str(args.get("tweet_id", "")).strip()
        if not tweet_id:
            return _err("Missing required argument: tweet_id")
        status, body = _call(
            "POST",
            f"/api/twitter/tweets/{urllib.parse.quote(tweet_id, safe='')}/favorite",
        )
        return _handle_response(status, body)

    if name == "twitter_unfavorite_tweet":
        tweet_id = str(args.get("tweet_id", "")).strip()
        if not tweet_id:
            return _err("Missing required argument: tweet_id")
        status, body = _call(
            "DELETE",
            f"/api/twitter/tweets/{urllib.parse.quote(tweet_id, safe='')}/favorite",
        )
        return _handle_response(status, body)

    if name == "twitter_retweet":
        tweet_id = str(args.get("tweet_id", "")).strip()
        if not tweet_id:
            return _err("Missing required argument: tweet_id")
        status, body = _call(
            "POST",
            f"/api/twitter/tweets/{urllib.parse.quote(tweet_id, safe='')}/retweet",
        )
        return _handle_response(status, body)

    if name == "twitter_delete_retweet":
        tweet_id = str(args.get("tweet_id", "")).strip()
        if not tweet_id:
            return _err("Missing required argument: tweet_id")
        status, body = _call(
            "DELETE",
            f"/api/twitter/tweets/{urllib.parse.quote(tweet_id, safe='')}/retweet",
        )
        return _handle_response(status, body)

    if name == "twitter_bookmark_tweet":
        tweet_id = str(args.get("tweet_id", "")).strip()
        if not tweet_id:
            return _err("Missing required argument: tweet_id")
        status, body = _call(
            "POST",
            f"/api/twitter/tweets/{urllib.parse.quote(tweet_id, safe='')}/bookmark",
        )
        return _handle_response(status, body)

    if name == "twitter_delete_bookmark":
        tweet_id = str(args.get("tweet_id", "")).strip()
        if not tweet_id:
            return _err("Missing required argument: tweet_id")
        status, body = _call(
            "DELETE",
            f"/api/twitter/tweets/{urllib.parse.quote(tweet_id, safe='')}/bookmark",
        )
        return _handle_response(status, body)

    if name == "twitter_follow_user":
        user_id = str(args.get("user_id", "")).strip()
        if not user_id:
            return _err("Missing required argument: user_id")
        status, body = _call(
            "POST",
            f"/api/twitter/users/{urllib.parse.quote(user_id, safe='')}/follow",
        )
        return _handle_response(status, body)

    if name == "twitter_unfollow_user":
        user_id = str(args.get("user_id", "")).strip()
        if not user_id:
            return _err("Missing required argument: user_id")
        status, body = _call(
            "DELETE",
            f"/api/twitter/users/{urllib.parse.quote(user_id, safe='')}/follow",
        )
        return _handle_response(status, body)

    # ----- DM tools ---------------------------------------------------
    # 1:1 DMs use /users/{user_id}/dms and /dms/{message_id}; group DMs
    # use /groups/{group_id}/dms and /groups/{group_id}/members. The
    # backend gate handles role checks, rate-limit budgets, and 429
    # surfacing — same as the tweet writes above.

    if name == "twitter_send_dm":
        user_id = str(args.get("user_id", "")).strip()
        text = str(args.get("text", "")).strip()
        if not user_id or not text:
            return _err("Missing required arguments: user_id and text")
        body_payload: dict = {"text": text}
        if args.get("media_id"):
            body_payload["media_id"] = str(args["media_id"])
        if args.get("reply_to"):
            body_payload["reply_to"] = str(args["reply_to"])
        status, body = _call(
            "POST",
            f"/api/twitter/users/{urllib.parse.quote(user_id, safe='')}/dms",
            body=body_payload,
        )
        return _handle_response(status, body)

    if name == "twitter_get_dm_history":
        user_id = str(args.get("user_id", "")).strip()
        if not user_id:
            return _err("Missing required argument: user_id")
        status, body = _call(
            "GET",
            f"/api/twitter/users/{urllib.parse.quote(user_id, safe='')}/dms",
            query={"max_id": args.get("max_id")},
        )
        return _handle_response(status, body)

    if name == "twitter_delete_dm":
        message_id = str(args.get("message_id", "")).strip()
        if not message_id:
            return _err("Missing required argument: message_id")
        status, body = _call(
            "DELETE",
            f"/api/twitter/dms/{urllib.parse.quote(message_id, safe='')}",
        )
        return _handle_response(status, body)

    if name == "twitter_add_dm_reaction":
        message_id = str(args.get("message_id", "")).strip()
        partner_id = str(args.get("partner_id", "")).strip()
        emoji = str(args.get("emoji", "")).strip()
        if not message_id or not partner_id or not emoji:
            return _err("Missing required arguments: message_id, partner_id, emoji")
        status, body = _call(
            "POST",
            f"/api/twitter/dms/{urllib.parse.quote(message_id, safe='')}/reaction",
            body={"partner_id": partner_id, "emoji": emoji},
        )
        return _handle_response(status, body)

    if name == "twitter_remove_dm_reaction":
        message_id = str(args.get("message_id", "")).strip()
        partner_id = str(args.get("partner_id", "")).strip()
        emoji = str(args.get("emoji", "")).strip()
        if not message_id or not partner_id or not emoji:
            return _err("Missing required arguments: message_id, partner_id, emoji")
        status, body = _call(
            "DELETE",
            f"/api/twitter/dms/{urllib.parse.quote(message_id, safe='')}/reaction",
            query={"partner_id": partner_id, "emoji": emoji},
        )
        return _handle_response(status, body)

    if name == "twitter_send_group_dm":
        group_id = str(args.get("group_id", "")).strip()
        text = str(args.get("text", "")).strip()
        if not group_id or not text:
            return _err("Missing required arguments: group_id and text")
        body_payload = {"text": text}
        if args.get("media_id"):
            body_payload["media_id"] = str(args["media_id"])
        if args.get("reply_to"):
            body_payload["reply_to"] = str(args["reply_to"])
        status, body = _call(
            "POST",
            f"/api/twitter/groups/{urllib.parse.quote(group_id, safe='')}/dms",
            body=body_payload,
        )
        return _handle_response(status, body)

    if name == "twitter_get_group_dm_history":
        group_id = str(args.get("group_id", "")).strip()
        if not group_id:
            return _err("Missing required argument: group_id")
        status, body = _call(
            "GET",
            f"/api/twitter/groups/{urllib.parse.quote(group_id, safe='')}/dms",
            query={"max_id": args.get("max_id")},
        )
        return _handle_response(status, body)

    if name == "twitter_get_group":
        group_id = str(args.get("group_id", "")).strip()
        if not group_id:
            return _err("Missing required argument: group_id")
        status, body = _call(
            "GET",
            f"/api/twitter/groups/{urllib.parse.quote(group_id, safe='')}",
        )
        return _handle_response(status, body)

    if name == "twitter_add_group_members":
        group_id = str(args.get("group_id", "")).strip()
        user_ids = args.get("user_ids") or []
        if not group_id:
            return _err("Missing required argument: group_id")
        if not isinstance(user_ids, list) or not user_ids:
            return _err("Missing required argument: user_ids (non-empty array)")
        status, body = _call(
            "POST",
            f"/api/twitter/groups/{urllib.parse.quote(group_id, safe='')}/members",
            body={"user_ids": [str(u) for u in user_ids]},
        )
        return _handle_response(status, body)

    if name == "twitter_change_group_name":
        group_id = str(args.get("group_id", "")).strip()
        new_name = str(args.get("name", "")).strip()
        if not group_id or not new_name:
            return _err("Missing required arguments: group_id and name")
        status, body = _call(
            "PATCH",
            f"/api/twitter/groups/{urllib.parse.quote(group_id, safe='')}/name",
            body={"name": new_name},
        )
        return _handle_response(status, body)

    return _err(f"Unknown tool: {name}")


# ---------------------------------------------------------------------------
# JSON-RPC stdio loop (mirrors backend/apps/discord_mcp_shim/server.py)
# ---------------------------------------------------------------------------

def _send(id_, result=None, error=None):
    msg = {"jsonrpc": "2.0", "id": id_}
    if error is not None:
        msg["error"] = error
    else:
        msg["result"] = result
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue

        method = msg.get("method")
        id_ = msg.get("id")
        params = msg.get("params", {}) or {}

        if method == "initialize":
            _send(id_, {
                "protocolVersion": "2024-11-05",
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "openswarm-twitter", "version": "1.0.0"},
            })
        elif method == "notifications/initialized":
            pass
        elif method == "tools/list":
            _send(id_, {"tools": TOOLS})
        elif method == "tools/call":
            name = params.get("name", "")
            args = params.get("arguments", {}) or {}
            try:
                _send(id_, handle_tool_call(name, args))
            except Exception as e:
                _send(id_, _err(f"shim crashed: {e!r}"))
        elif method == "ping":
            _send(id_, {})
        elif id_ is not None:
            _send(id_, error={"code": -32601, "message": f"Method not found: {method}"})


if __name__ == "__main__":
    main()
