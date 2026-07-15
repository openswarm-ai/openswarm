"""Unit tests for the general capture-replay write engine (route_write): the safety walls
(disarmed / off-origin / un-captured all refuse), CSRF-from-cookie derivation, the generic
receipt parse, and the fail-open contract (every failure is a typed ok=False, never a crash,
never a false success). Network is stubbed; the live cross-site round-trip is owed on a healthy
rig (this bench's renderer command path is wedged, same as all browser live-tests)."""
import pytest

from backend.apps.agents.browser import route_write as rw


def p_arm(monkeypatch):
    monkeypatch.setenv("OSW_ROUTE_WRITE", "1")


def p_reddit_route():
    return [rw.CapturedRoute(method="POST", template="https://www.reddit.com/api/comment")]


# --- safety walls -----------------------------------------------------------
def test_disarmed_by_default_refuses(monkeypatch):
    monkeypatch.delenv("OSW_ROUTE_WRITE", raising=False)
    out = rw.replay_write("POST", "https://www.reddit.com/api/comment", {"text": "hi"},
                          "https://www.reddit.com", p_reddit_route())
    assert out.ok is False and "disarmed" in out.error


def test_off_origin_target_refused(monkeypatch):
    p_arm(monkeypatch)
    out = rw.replay_write("POST", "https://evil.com/api/comment", {"text": "hi"},
                          "https://www.reddit.com", p_reddit_route())
    assert out.ok is False and "same-origin" in out.error


def test_uncaptured_route_refused(monkeypatch):
    p_arm(monkeypatch)
    # same origin, but the site's UI never fired /api/delete_account -> the agent can't invent it
    out = rw.replay_write("POST", "https://www.reddit.com/api/delete_account", {},
                          "https://www.reddit.com", p_reddit_route())
    assert out.ok is False and "captured" in out.error


def test_get_is_not_a_write_route(monkeypatch):
    p_arm(monkeypatch)
    assert rw.route_is_captured("GET", "https://www.reddit.com/api/comment", p_reddit_route()) is False


def test_template_match_ignores_volatile_ids(monkeypatch):
    # A volatile id that IS a full path segment collapses to {id} on both sides (same regex as the
    # capture), so a concrete replay URL matches the captured template but a different path doesn't.
    routes = [rw.CapturedRoute(method="DELETE", template="https://api.site.com/orders/{id}/cancel")]
    assert rw.route_is_captured("DELETE", "https://api.site.com/orders/4821/cancel", routes) is True
    assert rw.route_is_captured("DELETE", "https://api.site.com/refunds/4821/cancel", routes) is False


# --- CSRF-from-cookie derivation --------------------------------------------
def test_csrf_header_derived_from_cookie():
    h = rw.derive_csrf_headers("https://x.com/i/api/graphql/CreateTweet", "ct0=abc123; auth_token=z")
    assert h == {"x-csrf-token": "abc123"}


def test_no_csrf_for_plain_cookie_auth_site():
    assert rw.derive_csrf_headers("https://www.reddit.com/api/comment", "reddit_session=z") == {}


def test_csrf_absent_when_cookie_missing():
    assert rw.derive_csrf_headers("https://x.com/foo", "auth_token=z") == {}


# --- receipt parse ----------------------------------------------------------
def test_receipt_prefers_permalink_then_ids():
    assert rw.receipt_from_json({"json": {"data": {"permalink": "/r/x/c/1", "id": "t1_9"}}}) == "/r/x/c/1"
    assert rw.receipt_from_json({"data": {"create_tweet": {"tweet_results": {"rest_id": "1899"}}}}) == "1899"
    assert rw.receipt_from_json({"nothing": True}) == ""


def test_outcome_2xx_is_ok_with_receipt():
    out = rw.outcome_from_response(200, '{"id_str": "1899"}', 42)
    assert out.ok is True and out.receipt == "1899" and out.status == 200


def test_outcome_2xx_non_json_is_ok_generic_receipt():
    out = rw.outcome_from_response(201, "created", 5)
    assert out.ok is True and out.receipt == "ok"


def test_outcome_4xx_is_error():
    out = rw.outcome_from_response(403, "forbidden csrf", 9)
    assert out.ok is False and "403" in out.error


# --- end-to-end with the network + session stubbed --------------------------
def test_full_replay_success(monkeypatch):
    p_arm(monkeypatch)
    monkeypatch.setattr(rw, "get_session", lambda d: ("ct0=tok; sess=z", "UA/1.0"))
    seen = {}

    def fake_issue(method, url, body, headers):
        seen["method"], seen["url"], seen["body"], seen["headers"] = method, url, body, headers
        return 200, '{"json": {"data": {"things": [{"data": {"name": "t1_new", "permalink": "/r/x/c/a/_/t1_new"}}]}}}'

    monkeypatch.setattr(rw, "issue_request", fake_issue)
    out = rw.replay_write("POST", "https://www.reddit.com/api/comment", {"text": "nice", "thing_id": "t3_a"},
                          "https://www.reddit.com", p_reddit_route())
    assert out.ok is True and out.receipt == "/r/x/c/a/_/t1_new"
    assert seen["method"] == "POST" and "Cookie" in seen["headers"]
    assert "ct0=tok" in seen["headers"]["Cookie"]        # live-borrowed session, not persisted


def test_full_replay_no_session_is_typed_miss(monkeypatch):
    p_arm(monkeypatch)
    def boom(domain):
        raise RuntimeError("Not logged in")
    monkeypatch.setattr(rw, "get_session", boom)
    out = rw.replay_write("POST", "https://www.reddit.com/api/comment", {"text": "hi"},
                          "https://www.reddit.com", p_reddit_route())
    assert out.ok is False and "no borrowable session" in out.error


def test_full_replay_site_reject_is_typed_error(monkeypatch):
    p_arm(monkeypatch)
    monkeypatch.setattr(rw, "get_session", lambda d: ("sess=z", "UA/1.0"))
    monkeypatch.setattr(rw, "issue_request", lambda *a: (429, "rate limited"))
    out = rw.replay_write("POST", "https://www.reddit.com/api/comment", {"text": "hi"},
                          "https://www.reddit.com", p_reddit_route())
    assert out.ok is False and "429" in out.error
