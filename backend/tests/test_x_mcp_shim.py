"""Unit coverage for the X (Twitter) MCP shim's pure logic: tweet-id extraction, the
deeply-nested GraphQL tweet/cursor walker, the rate limiter, and tool dispatch with
the network mocked. Live posting can't be verified without a logged-in session, so the
GraphQL contract is pinned here against canned x.com payload shapes."""

import json
import time

from unittest.mock import patch

from backend.apps.social_shims.session_source import SessionUnavailable
from backend.apps.x_mcp_shim import rate_limit, x_reads, x_writes
from backend.apps.x_mcp_shim.handlers import handle_tool_call
from backend.apps.x_mcp_shim.x_reads import normalize_tweet, tweet_id_of


def p_text(result: dict) -> str:
    return result["content"][0]["text"]


CANNED_TWEET = {
    "__typename": "Tweet",
    "rest_id": "111",
    "legacy": {"full_text": "hello world", "favorite_count": 3, "retweet_count": 1,
               "reply_count": 0, "id_str": "111", "lang": "en"},
    "core": {"user_results": {"result": {"legacy": {"screen_name": "alice", "name": "Alice"}}}},
    "views": {"count": "42"},
}

CANNED_TIMELINE = {"data": {"search_by_raw_query": {"search_timeline": {"timeline": {"instructions": [
    {"type": "TimelineAddEntries", "entries": [
        {"entryId": "tweet-111", "content": {"itemContent": {"tweet_results": {"result": CANNED_TWEET}}}},
        {"entryId": "cursor-bottom", "content": {"cursorType": "Bottom", "value": "CURSOR123"}},
    ]},
]}}}}}


# -- id extraction + normalizers -------------------------------------------

def test_tweet_id_from_url_and_bare():
    assert tweet_id_of("https://x.com/alice/status/1850000000000000123") == "1850000000000000123"
    assert tweet_id_of("1850000000000000123") == "1850000000000000123"
    assert tweet_id_of("t_nope") == "t_nope"


def test_normalize_tweet_normalizes():
    t = normalize_tweet(CANNED_TWEET)
    assert t["id"] == "111" and t["author"] == "alice" and t["name"] == "Alice"
    assert t["text"] == "hello world" and t["likes"] == 3 and t["views"] == "42"


def test_normalize_tweet_unwraps_visibility_wrapper():
    wrapped = {"__typename": "TweetWithVisibilityResults", "tweet": CANNED_TWEET}
    assert normalize_tweet(wrapped)["id"] == "111"


def test_long_text_truncated():
    big = {"rest_id": "9", "legacy": {"full_text": "x" * 4000, "id_str": "9"}}
    body = normalize_tweet(big)["text"]
    assert len(body) < 4000 and "+2800 chars" in body


# -- rate limiter ----------------------------------------------------------

def test_first_read_is_prompt():
    start = time.time()
    rate_limit.acquire("read")
    assert time.time() - start < 1.2


def test_429_backoff_delays_next_request():
    rate_limit.note_response(429, {"retry-after": "1"})
    start = time.time()
    rate_limit.acquire("read")
    assert time.time() - start >= 0.8


# -- dispatch + normalizers (network mocked) -------------------------------

def test_search_walks_nested_timeline():
    with patch.object(x_reads, "graphql", return_value=CANNED_TIMELINE):
        out = handle_tool_call("x_search", {"query": "openswarm", "count": 10})
    data = json.loads(p_text(out))
    assert "isError" not in out
    assert data["cursor"] == "CURSOR123"
    assert data["tweets"][0]["id"] == "111"
    assert data["tweets"][0]["author"] == "alice"


def test_like_maps_to_favorite_op():
    captured: dict = {}

    def fake_graphql(op, variables, **kw):
        captured["op"], captured["vars"] = op, variables
        return {}

    with patch.object(x_writes, "graphql", fake_graphql):
        out = handle_tool_call("x_like", {"target": "https://x.com/a/status/1850000000000000111"})
    assert captured["op"] == "FavoriteTweet"
    assert captured["vars"]["tweet_id"] == "1850000000000000111"
    assert json.loads(p_text(out))["liked"] is True


def test_unlike_maps_to_unfavorite_op():
    captured: dict = {}
    with patch.object(x_writes, "graphql", lambda op, v, **k: captured.setdefault("op", op) or {}):
        handle_tool_call("x_like", {"target": "111", "unlike": True})
    assert captured["op"] == "UnfavoriteTweet"


def test_follow_resolves_id_and_hits_v11():
    captured: dict = {}

    def fake_rest(method, path, **kw):
        captured["path"], captured["form"] = path, kw.get("form")
        return {}

    with patch.object(x_writes, "resolve_user_id", return_value="999"), \
            patch.object(x_writes, "rest", fake_rest):
        out = handle_tool_call("x_follow", {"username": "@bob"})
    assert captured["path"] == "1.1/friendships/create.json"
    assert captured["form"]["user_id"] == "999"
    assert json.loads(p_text(out))["following"] is True


def test_session_unavailable_is_actionable():
    def boom(*a, **k):
        raise SessionUnavailable("Not logged in to x.com. Open x.com in the OpenSwarm browser, sign in, then retry.")

    with patch.object(x_reads, "rest", boom):
        out = handle_tool_call("x_whoami", {})
    assert out.get("isError") is True
    assert "logged in" in p_text(out).lower()


def test_unknown_tool_errors():
    out = handle_tool_call("x_nonsense", {})
    assert out.get("isError") is True
