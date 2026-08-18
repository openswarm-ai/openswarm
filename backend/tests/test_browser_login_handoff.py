"""Login-once handoff: registrable-domain keying, login-wall detection reuse, and the durable
authenticated-domains memory that keeps future runs from re-prompting."""
import os

import pytest

from backend.apps.agents.browser import browser_login_handoff as h


@pytest.fixture(autouse=True)
def temp_store(tmp_path, monkeypatch):
    monkeypatch.setattr(h, "P_STORE_PATH", os.path.join(str(tmp_path), "authenticated_domains.json"))


def test_registrable_domain_normalizes():
    assert h.registrable_domain("https://www.x.com/i/flow/login") == "x.com"
    assert h.registrable_domain("https://mail.google.com/mail/u/0") == "mail.google.com"
    assert h.registrable_domain("reddit.com") == "reddit.com"
    assert h.registrable_domain("https://X.COM:443/home") == "x.com"
    assert h.registrable_domain("") == ""


def test_login_wall_domain_reuses_the_one_detector():
    # a login URL is a wall
    assert h.login_wall_domain("https://x.com/i/flow/login", "") == "x.com"
    # a password field in the perception is a wall even off a login URL
    assert h.login_wall_domain("https://acme.example/app", '[3]<textbox "Password">') == "acme.example"
    # a normal page is not a wall
    assert h.login_wall_domain("https://x.com/home", '[1]<button "Post">') is None
    assert h.login_wall_domain("", "") is None


def test_record_then_authenticated():
    assert h.is_authenticated("x.com") is False
    h.record_login("https://x.com/i/flow/login")
    assert h.is_authenticated("x.com") is True
    assert h.is_authenticated("https://www.x.com/anything") is True
    assert h.authenticated_domains() == ["x.com"]


def test_first_seen_preserved_last_login_advances():
    h.record_login("reddit.com")
    first = h.login_record("reddit.com")
    h.record_login("reddit.com")
    second = h.login_record("reddit.com")
    assert second["first_seen"] == first["first_seen"]
    assert second["last_login"] >= first["last_login"]


def test_record_login_is_fail_open(monkeypatch, tmp_path):
    # an unwritable path must not raise; the run just treats it as a fresh sign-in next time
    # (a path UNDER a regular file is unwritable on every OS; a bare "/nonexistent-dir" is creatable on Windows)
    blocker = tmp_path / "not-a-dir"
    blocker.write_text("x", encoding="utf-8")
    monkeypatch.setattr(h, "P_STORE_PATH", str(blocker / "authenticated_domains.json"))
    h.record_login("x.com")  # no exception
    assert h.is_authenticated("x.com") is False


def test_blank_domain_never_recorded():
    h.record_login("")
    assert h.authenticated_domains() == []
