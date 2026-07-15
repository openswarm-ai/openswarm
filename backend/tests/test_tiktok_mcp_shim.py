"""Unit coverage for the TikTok MCP shim: query signing (device params + borrowed msToken),
the anti-bot/verify detector, HTTP read dispatch (item walker + normalizer), and the
browser-delegated writes (navigate + evaluate the user's own live card). Network + the
browser bridge are mocked; the live browser round-trip needs the running app + a logged-in
tiktok.com card, so it's asserted at the step-shape level here."""

import json
import time

from unittest.mock import patch

from backend.apps.social_shims.browser_action import BrowserActionError
from backend.apps.social_shims.session_source import SessionUnavailable
from backend.apps.tiktok_mcp_shim import rate_limit, tiktok_reads, tiktok_sign, tiktok_writes
from backend.apps.tiktok_mcp_shim.handlers import handle_tool_call
from backend.apps.tiktok_mcp_shim.tiktok_http import TikTokError, check_antibot

VIDEO_URL = "https://www.tiktok.com/@bob/video/777"


def p_text(result: dict) -> str:
    return result["content"][0]["text"]


CANNED_ITEM = {
    "id": "777", "desc": "a dance",
    "author": {"uniqueId": "bob", "nickname": "Bob"},
    "stats": {"diggCount": 9, "commentCount": 2, "playCount": 100, "shareCount": 1},
    "createTime": 123,
}


# -- signing ---------------------------------------------------------------

def test_signed_query_has_device_params_and_mstoken():
    with patch.object(tiktok_sign, "cookie_value", return_value="MSTOK123"):
        q = tiktok_sign.signed_query({"count": 5})
    assert "aid=1988" in q and "app_name=tiktok_web" in q
    assert "count=5" in q and "msToken=MSTOK123" in q


def test_signed_query_omits_mstoken_when_absent():
    with patch.object(tiktok_sign, "cookie_value", return_value=""):
        q = tiktok_sign.signed_query({})
    assert "msToken=" not in q


# -- anti-bot guard --------------------------------------------------------

def test_antibot_raises_with_browser_hint():
    check_antibot({"statusCode": 0})  # ok, no raise
    try:
        check_antibot({"statusCode": 10201, "statusMsg": "verify"})
        assert False, "expected TikTokError"
    except TikTokError as e:
        assert "browser" in str(e).lower()


# -- rate limiter ----------------------------------------------------------

def test_first_read_is_prompt():
    start = time.time()
    rate_limit.acquire("read")
    assert time.time() - start < 1.4


# -- read dispatch (network mocked; exercises the walker + normalizer) ------

def test_feed_walks_and_normalizes():
    canned = {"itemList": [CANNED_ITEM], "cursor": "5", "hasMore": True}
    with patch.object(tiktok_reads, "get", return_value=canned):
        out = handle_tool_call("tiktok_feed", {"count": 10})
    data = json.loads(p_text(out))
    v = data["videos"][0]
    assert v["id"] == "777" and v["author"] == "bob" and v["likes"] == 9
    assert v["url"] == VIDEO_URL and data["cursor"] == "5"


def test_read_session_unavailable_is_actionable():
    def boom(*a, **k):
        raise SessionUnavailable("Not logged in to tiktok.com. Open tiktok.com in the OpenSwarm browser, sign in, then retry.")

    with patch.object(tiktok_reads, "get", boom):
        out = handle_tool_call("tiktok_get_user", {"username": "bob"})
    assert out.get("isError") is True and "logged in" in p_text(out).lower()


# -- browser-delegated writes (bridge mocked) ------------------------------

def test_like_delegates_navigate_then_evaluate():
    captured: dict = {}

    def fake_perform(domain, steps):
        captured["domain"] = domain
        captured["ops"] = [s["op"] for s in steps]
        captured["nav"] = steps[0].get("url")
        return {"ok": True, "results": [{"text": json.dumps({"ok": True, "clicked": "like"})}]}

    with patch.object(tiktok_writes, "perform", fake_perform):
        out = handle_tool_call("tiktok_like", {"video_url": VIDEO_URL})
    assert captured["domain"] == "tiktok.com"
    assert captured["ops"] == ["navigate", "wait", "evaluate"]
    assert captured["nav"] == VIDEO_URL
    assert json.loads(p_text(out))["liked"] is True


def test_follow_navigates_to_profile():
    captured: dict = {}
    with patch.object(tiktok_writes, "perform",
                      lambda d, steps: captured.update(nav=steps[0]["url"]) or {"results": [{"text": '{"ok":true}'}]}):
        handle_tool_call("tiktok_follow", {"username": "@bob"})
    assert captured["nav"] == "https://www.tiktok.com/@bob"


def test_write_surfaces_no_card_error():
    def boom(domain, steps):
        raise BrowserActionError("No tiktok.com browser card is open. Open tiktok.com in an OpenSwarm browser card and sign in, then retry.")

    with patch.object(tiktok_writes, "perform", boom):
        out = handle_tool_call("tiktok_like", {"video_url": VIDEO_URL})
    assert out.get("isError") is True and "browser card" in p_text(out).lower()


def test_upload_opens_upload_page():
    captured: dict = {}

    def fake_perform(domain, steps):
        captured["url"] = steps[0].get("url")
        return {"ok": True, "results": []}

    with patch.object(tiktok_writes, "perform", fake_perform):
        out = handle_tool_call("tiktok_upload", {"caption": "hi", "video_path": "/tmp/v.mp4"})
    data = json.loads(p_text(out))
    assert data["opened"].endswith("/upload") and captured["url"].endswith("/upload")
    assert "/tmp/v.mp4" in data["note"]


def test_unknown_tool_errors():
    out = handle_tool_call("tiktok_nonsense", {})
    assert out.get("isError") is True
