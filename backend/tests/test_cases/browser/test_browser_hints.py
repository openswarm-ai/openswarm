"""Per-domain advisory hint store for the browser sub-agent."""

from backend.apps.agents.browser import browser_history as bh


def setup_function(_):
    bh._domain_notes.clear()


def test_set_get_roundtrip():
    bh.set_domain_note("notion.so", "Share button is top-right; Tab into the dialog.")
    assert "Share button" in bh.get_domain_note("notion.so")


def test_caps_length():
    bh.set_domain_note("x.com", "a" * 5000)
    assert len(bh.get_domain_note("x.com")) == bh._MAX_DOMAIN_NOTE_CHARS


def test_ignores_empty_domain_or_note():
    bh.set_domain_note("", "note")
    bh.set_domain_note("y.com", "")
    bh.set_domain_note("z.com", "   ")
    assert bh.get_domain_note("") == ""
    assert bh.get_domain_note("y.com") == ""
    assert bh.get_domain_note("z.com") == ""


def test_unknown_domain_returns_empty():
    assert bh.get_domain_note("never.seen") == ""


def test_overwrite_keeps_latest():
    bh.set_domain_note("docs.google.com", "first note")
    bh.set_domain_note("docs.google.com", "second note")
    assert bh.get_domain_note("docs.google.com") == "second note"
