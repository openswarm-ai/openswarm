"""Borrowing the user's existing sign-in instead of interrupting them for a password.

This module reads the user's real browser, so the tests are mostly about what it must REFUSE to do.
Nothing here touches a real store or a keychain: the reader is stubbed at every call site.
"""
import os
import re

import pytest

from backend.apps.agents.browser import browser_session_import as si
from backend.apps.settings.models import AppSettings

P_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
P_MAIN_JS = os.path.join(P_REPO_ROOT, "electron", "main.js")

RECORDS = [{"name": "sid", "value": "opaque", "domain": ".x.com", "path": "/",
            "secure": True, "httponly": True, "expires": 1900000000.0}]


def test_opt_in_is_off_by_default():
    """Reading someone's real browser is their call to make explicitly. If this ever defaults True,
    an upgrade would silently start reading stores the user never agreed to expose."""
    assert si.is_enabled(AppSettings()) is False


def test_opt_in_flips():
    s = AppSettings()
    s.browser_import_signins = True
    assert si.is_enabled(s) is True


def test_google_properties_route_to_the_sso_scope():
    """A Gmail/YouTube session lives on the parent SSO domain, not the property's own host, and the
    reader has a NAMED scope for it. Getting this wrong means either no session at all or a general
    sweep of every google entry the user owns."""
    for d in ("mail.google.com", "google.com", "docs.google.com", "youtube.com", "www.youtube.com"):
        assert si.is_google_property(d), d
    for d in ("reddit.com", "x.com", "notgoogle.com", "google.com.evil.net", ""):
        assert not si.is_google_property(d), d


def test_domain_normalisation_matches_the_handoff():
    """One definition of 'which site is this', shared with the login handoff, or the two can
    disagree about which domain we just borrowed for."""
    assert si.site_domain("https://www.reddit.com/submit?x=1") == "reddit.com"
    assert si.site_domain("x.com") == "x.com"
    assert si.site_domain("") == ""


@pytest.mark.asyncio
async def test_no_session_never_wakes_the_bridge(monkeypatch):
    """Nothing to import means nothing to send. Calling the renderer with an empty payload would
    burn a round trip and log a bogus failure."""
    called = []
    monkeypatch.setattr(si, "read_site_records", lambda d: [])
    monkeypatch.setattr(si.ws_manager, "send_browser_command",
                        lambda *a, **k: called.append(a) or {})
    result = await si.import_signin("x.com", "b1")
    assert result.outcome == "no_session"
    assert result.ok is False
    assert called == []


@pytest.mark.asyncio
async def test_empty_domain_reads_nothing(monkeypatch):
    """A blank URL must not turn into a wildcard read."""
    monkeypatch.setattr(si, "read_site_records",
                        lambda d: pytest.fail("must not read for an empty domain"))
    assert (await si.import_signin("", "b1")).outcome == "no_session"


@pytest.mark.asyncio
async def test_successful_import_reports_what_landed(monkeypatch):
    async def fake_send(rid, action, browser_id, params, **kw):
        assert action == "import_session"
        assert params["domain"] == "x.com"
        assert params["cookies"] == RECORDS
        return {"ok": True, "set": 1, "total": 1}

    monkeypatch.setattr(si, "read_site_records", lambda d: list(RECORDS))
    monkeypatch.setattr(si.ws_manager, "send_browser_command", fake_send)
    result = await si.import_signin("https://x.com/compose/post", "b1")
    assert result.outcome == "imported"
    assert result.ok is True
    assert result.entries_applied == 1
    assert result.domain == "x.com"


@pytest.mark.asyncio
async def test_bridge_error_is_a_result_not_an_exception(monkeypatch):
    """Every failure has to degrade into something the caller can fall back from, because the
    fallback (ask the user to sign in) is the behaviour that existed before this did."""
    async def fake_send(*a, **k):
        return {"error": "No dashboard is connected."}

    monkeypatch.setattr(si, "read_site_records", lambda d: list(RECORDS))
    monkeypatch.setattr(si.ws_manager, "send_browser_command", fake_send)
    result = await si.import_signin("x.com", "b1")
    assert result.outcome == "bridge_failed"
    assert result.ok is False


@pytest.mark.asyncio
async def test_applied_nothing_is_not_success(monkeypatch):
    """The bridge answering 'ok' while applying zero entries must NOT read as signed in, or the run
    skips the pause and then fails on a page it still cannot use."""
    async def fake_send(*a, **k):
        return {"ok": True, "set": 0, "total": 4}

    monkeypatch.setattr(si, "read_site_records", lambda d: list(RECORDS))
    monkeypatch.setattr(si.ws_manager, "send_browser_command", fake_send)
    assert (await si.import_signin("x.com", "b1")).ok is False


def test_expiry_is_translated_out_of_chromium_time(monkeypatch):
    """Chromium counts microseconds from 1601; Electron wants unix seconds. Get this wrong and every
    borrowed entry is either already expired or session-scoped, so the sign-in dies on the next quit
    and the user quietly stops believing the feature works."""
    monkeypatch.setattr(si.browser_cookies, "read_provider_cookie_records",
                        lambda d: [{"name": "sid", "value": "opaque", "expires_utc": 13400000000000000},
                                   {"name": "tmp", "value": "opaque", "expires_utc": 0}])
    out = si.read_site_records("x.com")
    assert out[0]["expires"] == pytest.approx(1755526400.0)
    assert out[1]["expires"] == 0.0, "a session entry must stay session-scoped, not become 1601"


def test_fingerprint_bound_clearance_is_left_behind(monkeypatch):
    """Anti-bot clearance is minted against the UA and IP that earned it, and our webview keeps an
    'openswarm/' token in its UA, so a borrowed clearance can never match. Replaying a mismatched
    one reads as token theft and gets us challenged HARDER than arriving with none, while the real
    session cookies beside it are perfectly portable."""
    monkeypatch.setattr(si.browser_cookies, "read_provider_cookie_records", lambda d: [
        {"name": "sid", "value": "opaque", "expires_utc": 0},
        {"name": "uid", "value": "opaque", "expires_utc": 0},
        {"name": "cf_clearance", "value": "opaque", "expires_utc": 0},
        {"name": "__cf_bm", "value": "opaque", "expires_utc": 0},
        {"name": "datadome", "value": "opaque", "expires_utc": 0},
    ])
    assert sorted(r["name"] for r in si.read_site_records("medium.com")) == ["sid", "uid"]


def test_google_reads_go_through_the_named_sso_scope(monkeypatch):
    """A Gmail borrow must use the reader's named SSO set, never a general sweep of the user's
    google entries."""
    monkeypatch.setattr(si.browser_cookies, "read_google_session_records",
                        lambda: [{"name": "SID", "value": "opaque", "expires_utc": 0}])
    monkeypatch.setattr(si.browser_cookies, "read_provider_cookie_records",
                        lambda d: pytest.fail("google must not go through the generic read"))
    assert [r["name"] for r in si.read_site_records("mail.google.com")] == ["SID"]


def test_unreadable_browser_degrades_instead_of_crashing(monkeypatch):
    """A locked keychain, a v20 app-bound store, a browser that isn't installed: all of it is a
    fallback, never an exception that kills the run."""
    def boom(d):
        raise RuntimeError("read denied")

    monkeypatch.setattr(si.browser_cookies, "read_provider_cookie_records", boom)
    assert si.read_site_records("x.com") == []

    monkeypatch.setattr(si.browser_cookies, "p_best_store", boom)
    assert si.has_importable_session("x.com") is False


@pytest.mark.asyncio
async def test_a_broken_borrow_can_never_break_the_run(monkeypatch):
    """The class this seals: borrowing is a convenience bolted onto the critical path, so ANY
    failure inside it must cost at most the pause we were going to show anyway. Caught for real by
    the suite, where a loose settings double made the helper raise and killed the whole browser run
    before it could even reach the sign-in prompt."""
    from backend.apps.agents.browser import browser_agent

    def boom(*a, **k):
        raise TypeError("settings double is not the real thing")

    monkeypatch.setattr(browser_agent.browser_session_import, "is_enabled", boom)
    assert await browser_agent.try_borrow_signin("acme.example", "b1", "", "") is False


@pytest.mark.asyncio
async def test_borrow_happens_at_the_door_not_only_at_the_wall(monkeypatch):
    """Borrowing only at a detected wall was too late: a task the model answers in one turn calls
    Done, which breaks the loop BEFORE the handoff runs, so short tasks never got the session at
    all. Navigating must carry it."""
    from backend.apps.agents.browser import browser_agent

    seen = []
    browser_agent.p_signin_borrowed.discard("x.com")
    monkeypatch.setattr(browser_agent.browser_session_import, "is_enabled", lambda s: True)
    monkeypatch.setattr(browser_agent.browser_session_import, "has_importable_session", lambda d: True)

    async def fake_import(domain, browser_id):
        seen.append(domain)
        return si.SessionImportResult(outcome="imported", domain=domain, entries_applied=3)

    monkeypatch.setattr(browser_agent.browser_session_import, "import_signin", fake_import)
    await browser_agent.p_borrow_signin_before_nav("https://x.com/compose/post", "b1")
    assert seen == ["x.com"], "navigating to a site must borrow its sign-in first"

    # Second navigate to the same site must not re-read the user's browser.
    await browser_agent.p_borrow_signin_before_nav("https://x.com/home", "b1")
    assert seen == ["x.com"], "a borrowed site must not be re-imported on every navigate"
    browser_agent.p_signin_borrowed.discard("x.com")


@pytest.mark.asyncio
async def test_pre_nav_borrow_respects_the_opt_in(monkeypatch):
    """The door is the busiest path in the whole agent, so the gate has to hold there too."""
    from backend.apps.agents.browser import browser_agent

    browser_agent.p_signin_borrowed.discard("x.com")
    monkeypatch.setattr(browser_agent.browser_session_import, "is_enabled", lambda s: False)
    monkeypatch.setattr(browser_agent.browser_session_import, "has_importable_session",
                        lambda d: pytest.fail("must not probe the user's browser while opted out"))
    await browser_agent.p_borrow_signin_before_nav("https://x.com/home", "b1")


@pytest.mark.asyncio
async def test_wall_handoff_asks_a_human_once_the_door_borrow_did_not_take(monkeypatch):
    """If we already borrowed at the door and are STILL at a wall, the session did not work.
    Re-importing identical values would change nothing, so this case belongs to the human, and
    silently returning True here would skip the prompt and strand the run."""
    from backend.apps.agents.browser import browser_agent

    browser_agent.p_signin_borrowed.add("acme.example")
    monkeypatch.setattr(browser_agent.browser_session_import, "is_enabled", lambda s: True)
    monkeypatch.setattr(browser_agent.browser_session_import, "import_signin",
                        lambda d, b: pytest.fail("must not re-import the same values"))
    try:
        assert await browser_agent.try_borrow_signin("acme.example", "b1", "", "") is False
    finally:
        browser_agent.p_signin_borrowed.discard("acme.example")


def test_agent_checks_the_opt_in_before_reading_anything():
    """INVARIANT: the borrow helper must consult the setting FIRST. Pinned by source because the
    ordering is the whole consent story, and an innocent-looking reorder would start reading the
    user's browser before asking whether they wanted that."""
    import inspect

    from backend.apps.agents.browser import browser_agent

    src = inspect.getsource(browser_agent.try_borrow_signin)
    gate = src.index("is_enabled")
    assert gate < src.index("has_importable_session"), "opt-in must be checked before probing"
    assert gate < src.index("import_signin"), "opt-in must be checked before importing"


def test_partition_write_confines_entries_to_the_requested_domain():
    """INVARIANT on the Electron side: importing one site must never plant another site's session
    in the partition. Pinned by source since main.js needs a live Electron to execute."""
    with open(P_MAIN_JS, encoding="utf-8") as fh:
        src = fh.read()
    body = src[src.index("async function writePartitionCookies"):]
    body = body[:body.index("ipcMain.handle('set-partition-cookies'")]
    assert re.search(r"if \(host !== d && !host\.endsWith\(`\.\$\{d\}`\)\) continue;", body), \
        "the per-entry domain confinement guard is gone from writePartitionCookies"
