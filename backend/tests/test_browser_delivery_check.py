"""Delivery ground-truth for writes: ghost-drop host detection + the persistence probe that
keeps a cleared-composer from being reported as a real delivery on sites that silently eat posts.
"""
import pytest

from backend.apps.agents.browser import browser_delivery_check as dc


def test_ghost_drop_host_matches_youtube_only():
    assert dc.is_ghost_drop_host("https://www.youtube.com/watch?v=abc")
    assert dc.is_ghost_drop_host("https://youtube.com/watch")
    assert dc.is_ghost_drop_host("https://m.youtube.com/watch")
    # every proven-good write host stays OFF the ghost path (zero added latency there)
    assert not dc.is_ghost_drop_host("https://x.com/home")
    assert not dc.is_ghost_drop_host("https://www.reddit.com/r/test")
    assert not dc.is_ghost_drop_host("https://mail.google.com/mail")
    assert not dc.is_ghost_drop_host("https://www.linkedin.com/feed/")
    assert not dc.is_ghost_drop_host("")
    # a lookalike domain must not match the bare-endswith by accident
    assert not dc.is_ghost_drop_host("https://notyoutube.com.evil.test/")


def test_probe_expression_escapes_and_truncates():
    expr = dc.delivery_probe_expression('hi "there"\nsecond line ' + "z" * 200)
    assert expr.startswith("(()=>{")
    assert '\\"there\\"' in expr  # the quote is JSON-escaped, not raw
    assert "z" * 80 not in expr   # needle capped at 80 chars
    empty = dc.delivery_probe_expression("")
    assert 'n.length>0' in empty  # an empty payload can never falsely "match"


def make_exec(visibility_sequence):
    """execute_tool stub: each BrowserEvaluate returns the next scripted visibility."""
    seq = list(visibility_sequence)
    calls = {"n": 0}

    async def execute_tool(tool, params, browser_id, tab_id):
        assert tool == "BrowserEvaluate"
        v = seq[calls["n"]] if calls["n"] < len(seq) else False
        calls["n"] += 1
        return {"value": {"visible": bool(v)}}

    return execute_tool, calls


@pytest.fixture(autouse=True)
def no_real_sleep(monkeypatch):
    async def instant(_):
        return None
    monkeypatch.setattr(dc.asyncio, "sleep", instant)


@pytest.mark.asyncio
async def test_delivery_confirmed_when_post_persists():
    ex, calls = make_exec([True, True])  # visible now, still visible after the drop window
    assert await dc.ghost_delivery_confirmed("payload", "b", "t", ex) is True
    assert calls["n"] == 2


@pytest.mark.asyncio
async def test_delivery_false_when_never_rendered():
    ex, calls = make_exec([False])  # never rendered -> no second probe, honest False
    assert await dc.ghost_delivery_confirmed("payload", "b", "t", ex) is False
    assert calls["n"] == 1


@pytest.mark.asyncio
async def test_delivery_false_when_rendered_then_dropped():
    ex, calls = make_exec([True, False])  # optimistic render, then silently gone (the YouTube class)
    assert await dc.ghost_delivery_confirmed("payload", "b", "t", ex) is False
    assert calls["n"] == 2


@pytest.mark.asyncio
async def test_ghost_confirm_false_when_probe_tool_errors():
    async def boom(tool, params, browser_id, tab_id):
        return {"error": "boom"}
    # a broken/erroring page read must fail closed to "not confirmed", never a false delivery
    assert await dc.ghost_delivery_confirmed("x", "b", "t", boom) is False


def test_unconfirmed_note_is_honest_and_names_the_host():
    note = dc.unconfirmed_delivery_note("https://www.youtube.com/watch", "hello world")
    assert "hello world" in note
    assert "youtube.com" in note and "www." not in note
    assert "could NOT confirm" in note
    assert "check your posts" in note.lower()
