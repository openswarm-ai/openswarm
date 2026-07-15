"""Unit coverage for the Reddit MCP shim's pure logic: the modhash write-token harvest,
the rate limiter's 429 backoff, and tool dispatch + response normalizers with the
network mocked. Reddit is driven via www.reddit.com's JSON API + the session cookie
(reads get .json, writes carry the modhash); the contract is pinned here against canned
Reddit payloads (the me.json envelope, the json.errors envelope, comment/submit shapes)."""

import json
import time

from unittest.mock import patch

from backend.apps.reddit_mcp_shim import rate_limit, reddit_reads, reddit_writes
from backend.apps.reddit_mcp_shim.handlers import handle_tool_call
from backend.apps.social_shims.session_source import SessionUnavailable


def p_text(result: dict) -> str:
    return result["content"][0]["text"]


# -- whoami reads the me.json envelope (kind/data), not the old flat oauth shape ----

def test_whoami_reads_me_json_envelope():
    with patch.object(reddit_reads, "api", return_value={"kind": "t2", "data": {"name": "someuser", "total_karma": 5}}):
        out = handle_tool_call("reddit_whoami", {})
    data = json.loads(p_text(out))
    assert "isError" not in out
    assert data["name"] == "someuser" and data["total_karma"] == 5


# -- rate limiter ----------------------------------------------------------

def test_first_read_is_prompt():
    start = time.time()
    rate_limit.acquire("read")
    assert time.time() - start < 1.0


def test_429_backoff_delays_next_request():
    rate_limit.note_response(429, {"retry-after": "1"})
    start = time.time()
    rate_limit.acquire("read")
    assert time.time() - start >= 0.8


# -- dispatch + normalizers (network mocked) -------------------------------

def test_browse_normalizes_listing():
    listing = {"data": {"after": "t3_next", "children": [
        {"kind": "t3", "data": {"name": "t3_a", "subreddit": "python", "author": "u1",
                                "title": "Hello", "score": 42, "num_comments": 5,
                                "permalink": "/r/python/comments/a/", "selftext": "body"}},
    ]}}
    with patch.object(reddit_reads, "api", return_value=listing):
        out = handle_tool_call("reddit_browse", {"subreddit": "python", "limit": 5})
    data = json.loads(p_text(out))
    assert "isError" not in out
    assert data["after"] == "t3_next"
    assert data["items"][0]["id"] == "t3_a"
    assert data["items"][0]["title"] == "Hello"


def test_long_selftext_truncated():
    listing = {"data": {"children": [{"kind": "t3", "data": {"name": "t3_a", "selftext": "x" * 5000}}]}}
    with patch.object(reddit_reads, "api", return_value=listing):
        out = handle_tool_call("reddit_browse", {})
    body = json.loads(p_text(out))["items"][0]["selftext"]
    assert len(body) < 5000 and "+3000 chars" in body


def test_get_post_splits_post_and_comments():
    arr = [
        {"data": {"children": [{"kind": "t3", "data": {"name": "t3_a", "title": "Q"}}]}},
        {"data": {"children": [{"kind": "t1", "data": {"name": "t1_c", "body": "A"}}]}},
    ]
    with patch.object(reddit_reads, "api", return_value=arr):
        out = handle_tool_call("reddit_get_post", {"target": "https://www.reddit.com/r/x/comments/a/title/"})
    data = json.loads(p_text(out))
    assert data["post"]["id"] == "t3_a"
    assert data["comments"][0]["id"] == "t1_c"


def test_vote_maps_direction():
    captured: dict = {}

    def fake_api(method, path, *, params=None, form=None, action="read"):
        captured["form"], captured["action"] = form, action
        return {}

    with patch.object(reddit_writes, "api", fake_api):
        out = handle_tool_call("reddit_vote", {"thing_id": "t3_x", "direction": "down"})
    assert captured["form"]["dir"] == -1
    assert captured["action"] == "vote"
    assert json.loads(p_text(out))["dir"] == -1


def test_comment_parses_new_thing():
    resp = {"json": {"errors": [], "data": {"things": [
        {"kind": "t1", "data": {"name": "t1_new", "permalink": "/r/x/comments/a/_/t1_new/"}}]}}}
    with patch.object(reddit_writes, "api", return_value=resp):
        out = handle_tool_call("reddit_comment", {"parent_id": "t3_a", "text": "nice"})
    assert json.loads(p_text(out))["id"] == "t1_new"


def test_submit_surfaces_reddit_errors():
    envelope = {"json": {"errors": [["SUBREDDIT_NOEXIST", "that subreddit doesn't exist", "sr"]], "data": {}}}
    with patch.object(reddit_writes, "api", return_value=envelope):
        out = handle_tool_call("reddit_submit", {"subreddit": "nope", "title": "hi"})
    assert out.get("isError") is True
    assert "doesn't exist" in p_text(out)


def test_session_unavailable_is_actionable():
    def boom(*a, **k):
        raise SessionUnavailable("Not logged in to reddit.com. Open reddit.com in the OpenSwarm browser, sign in, then retry.")

    with patch.object(reddit_reads, "api", boom):
        out = handle_tool_call("reddit_whoami", {})
    assert out.get("isError") is True
    assert "logged in" in p_text(out).lower()


def test_unknown_tool_errors():
    out = handle_tool_call("reddit_nonsense", {})
    assert out.get("isError") is True
