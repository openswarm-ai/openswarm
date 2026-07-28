"""A submit we never located must prove the payload rendered before it counts as delivered.

Measured live on LinkedIn's feed composer 2026-07-28: both structured resolvers missed, so the tail
fell back to clicking a button literally named "Send". LinkedIn's feed composer submits with "Post",
so that click landed on some OTHER widget's Send, returned no error, and the composer cleared
anyway. Receipt passed. `sent_receipt=True`. Nothing was posted, on either the posts or the
comments tab.

That is the dangerous direction: a cleared composer cannot tell "submitted" from "dismissed", and
every honesty guarantee downstream is built on that receipt. So the guessed path, and only the
guessed path, has to show the text actually rendered on the page. The two resolved paths keep their
measured speed and are untouched.
"""
import pytest

from backend.apps.agents.browser import browser_send_script as ss

PAYLOAD = "hello from my automation"
COMMITTED = f'[2]<textbox "Write a message" value="{PAYLOAD}">'
CLEARED = '[2]<textbox "Write a message">\n[9]<button "Attach">'


def make_exec(*, submit_listed: bool, container_ok: bool, visible_after: bool, cleared: bool = True):
    """A composer whose submit is or isn't resolvable, and a page that does or doesn't end up
    showing the payload. Records which route the tail took."""
    calls = {"clicks": [], "lists": 0, "evals": []}

    async def execute(tool, params, bid, tid):
        if tool == "BrowserListInteractives":
            calls["lists"] += 1
            first = calls["lists"] == 1
            state = COMMITTED if (first or not cleared) else CLEARED
            if submit_listed:
                state += '\n[14]<button "Send">'
            return {"text": state}
        if tool == "BrowserEvaluate":
            expr = str(params.get("expression") or "")
            calls["evals"].append(expr)
            if "visible" in expr:                     # the delivery probe
                return {"text": f'{{"visible": {str(visible_after).lower()}}}'}
            if container_ok:                          # the container submit resolver
                return {"text": '{"ok": true, "xPct": 50.0, "yPct": 50.0, "name": "Post"}'}
            return {"text": '{"ok": false, "why": "no submit control in the composer container"}'}
        calls["clicks"].append((tool, params))
        return {"ok": True}
    return execute, calls


def send_index(state, composer_index):
    for line in (state or "").splitlines():
        if '<button "Send">' in line:
            return (14, "Send")
    return None


async def run_tail(**kw):
    ex, calls = make_exec(**kw)
    r = await ss.complete_send(PAYLOAD, COMMITTED, "b1", "t1", ex, send_index,
                               composer_index=2, current_url="https://www.linkedin.com/feed/")
    return r, calls


@pytest.mark.asyncio
async def test_a_guessed_send_that_never_rendered_is_not_delivered():
    """The exact live failure. Composer cleared, so the old code called it sent; the payload is
    nowhere on the page, so it wasn't."""
    r, calls = await run_tail(submit_listed=False, container_ok=False, visible_after=False)
    assert any(t == "BrowserClickByName" for t, _ in calls["clicks"]), "this must take the guessed path"
    assert r["delivered"] is False, "a guessed click with no rendered payload must not claim delivery"


@pytest.mark.asyncio
async def test_a_guessed_send_that_did_render_is_delivered():
    """The guard must not punish the guessed path when it genuinely worked, or the by-name fallback
    (load-bearing for LinkedIn message threads, where the button really is 'Send') becomes useless."""
    r, calls = await run_tail(submit_listed=False, container_ok=False, visible_after=True)
    assert any(t == "BrowserClickByName" for t, _ in calls["clicks"])
    assert r["delivered"] is True


@pytest.mark.asyncio
async def test_a_resolved_submit_is_not_slowed_down_by_the_new_probe():
    """Speed guard. The ranked-index path is the proven one (X, ~23s end to end); it must not start
    paying for a delivery probe it never needed."""
    r, calls = await run_tail(submit_listed=True, container_ok=True, visible_after=False)
    assert r["sent"] is True
    assert r["delivered"] is None, "a resolved submit keeps trusting the receipt, as measured"
    assert not any("visible" in e for e in calls["evals"]), "no delivery probe on the resolved path"


@pytest.mark.asyncio
async def test_the_container_resolved_submit_also_skips_the_probe():
    """Container resolution locates the real control inside the composer, so it is not a guess."""
    r, calls = await run_tail(submit_listed=False, container_ok=True, visible_after=False)
    assert r["sent"] is True
    assert r["delivered"] is None
    assert not any("visible" in e for e in calls["evals"])


@pytest.mark.asyncio
async def test_a_composer_that_never_cleared_is_still_not_sent():
    """The probe is an EXTRA hurdle for guessed clicks, never a way around the receipt: if the
    composer still holds the text, nothing was sent no matter what else is on the page."""
    r, _ = await run_tail(submit_listed=False, container_ok=False, visible_after=True, cleared=False)
    assert r["sent"] is False
