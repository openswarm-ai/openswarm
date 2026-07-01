"""Unit coverage for the X MCP shim (browser-delegation): tweet-id extraction and that each
tool drives the right navigate + evaluate steps against the user's own x.com card. The
perform_action bridge is mocked; live DOM behavior needs the running app + a logged-in X card
(the data-testid selectors in x_dom are the isolated assumption, live-verified separately)."""

import json

from unittest.mock import patch

from backend.apps.social_shims.browser_action import BrowserActionError
from backend.apps.x_mcp_shim import x_reads, x_writes
from backend.apps.x_mcp_shim.handlers import handle_tool_call
from backend.apps.x_mcp_shim.x_reads import tweet_id_of

TWEET_URL = "https://x.com/alice/status/1850000000000000123"


def p_text(result: dict) -> str:
    return result["content"][0]["text"]


def perform_returning(payload):
    """A fake perform() that records the steps and returns payload as the last evaluate's output."""
    calls: dict = {}

    def fake(domain, steps):
        calls["domain"] = domain
        calls["ops"] = [s["op"] for s in steps]
        calls["urls"] = [s.get("url") for s in steps if s["op"] == "navigate"]
        return {"ok": True, "results": [{"text": json.dumps(payload)}]}

    return fake, calls


# -- id extraction ---------------------------------------------------------

def test_tweet_id_of():
    assert tweet_id_of(TWEET_URL) == "1850000000000000123"
    assert tweet_id_of("1850000000000000123") == "1850000000000000123"
    assert tweet_id_of("nope") == "nope"


# -- reads drive the right URL + scrape ------------------------------------

def test_search_drives_search_url_and_scrapes():
    fake, calls = perform_returning([{"id": "111", "author": "bob", "text": "openswarm rocks", "likes": 42, "url": TWEET_URL}])
    with patch.object(x_reads, "perform", fake):
        out = handle_tool_call("x_search", {"query": "openswarm", "product": "top", "count": 5})
    data = json.loads(p_text(out))
    assert "isError" not in out
    assert calls["domain"] == "x.com"
    assert any("search?q=openswarm" in (u or "") for u in calls["urls"])
    assert data["tweets"][0]["author"] == "bob" and data["count"] == 1


def test_user_tweets_navigates_to_profile():
    fake, calls = perform_returning([])
    with patch.object(x_reads, "perform", fake):
        handle_tool_call("x_user_tweets", {"username": "@bob", "count": 5})
    assert calls["urls"][0] == "https://x.com/bob"


# -- writes drive navigate + evaluate on the card --------------------------

def test_like_navigates_to_tweet_and_evaluates():
    fake, calls = perform_returning({"ok": True, "action": "like"})
    with patch.object(x_writes, "perform", fake):
        out = handle_tool_call("x_like", {"target": TWEET_URL})
    assert calls["urls"][0] == TWEET_URL
    assert "evaluate" in calls["ops"]
    assert json.loads(p_text(out))["liked"] is True


def test_reply_opens_composer_then_posts():
    fake, calls = perform_returning({"ok": True, "posted": True})
    with patch.object(x_writes, "perform", fake):
        out = handle_tool_call("x_tweet", {"text": "🔥", "reply_to": TWEET_URL})
    assert calls["urls"][0] == TWEET_URL
    assert calls["ops"].count("evaluate") == 2  # open_reply + post_text
    assert json.loads(p_text(out))["replied_to"] == TWEET_URL


def test_compose_goes_to_composer():
    fake, calls = perform_returning({"ok": True, "posted": True})
    with patch.object(x_writes, "perform", fake):
        handle_tool_call("x_tweet", {"text": "hello world"})
    assert any("compose/post" in (u or "") for u in calls["urls"])


def test_follow_navigates_to_profile():
    fake, calls = perform_returning({"ok": True, "following": True})
    with patch.object(x_writes, "perform", fake):
        out = handle_tool_call("x_follow", {"username": "@bob"})
    assert calls["urls"][0] == "https://x.com/bob"
    assert json.loads(p_text(out))["following"] is True


def test_delete_is_card_only():
    out = handle_tool_call("x_delete_tweet", {"target": TWEET_URL})
    assert out.get("isError") is True and "card" in p_text(out).lower()


def test_no_card_error_surfaces():
    def boom(*a, **k):
        raise BrowserActionError("No x.com browser card is open. Open x.com in an OpenSwarm browser card and sign in, then retry.")

    with patch.object(x_writes, "perform", boom):
        out = handle_tool_call("x_like", {"target": TWEET_URL})
    assert out.get("isError") is True and "card" in p_text(out).lower()


def test_unknown_tool_errors():
    out = handle_tool_call("x_nonsense", {})
    assert out.get("isError") is True
