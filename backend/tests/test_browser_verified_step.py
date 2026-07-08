"""The verified-step loop: resolve-late -> act -> verify-effect -> re-aim, in code.
Pins the two properties the executor stands on: a reversible miss re-aims without an
LLM turn, and an irreversible action NEVER re-fires once it has acted (the send-script's
honesty rule, generalized)."""
import pytest

from backend.apps.agents.browser import browser_verified_step as vs

MENU_CLOSED = '[5]<button "Options">\n[9]<link "Home">'
MENU_OPEN = '[5]<button "Options">\n[6]<menuitem "Delete draft">\n[9]<link "Home">'
BOX_EMPTY = '[2]<textbox "Write a message">'
BOX_FILLED = '[2]<textbox "Write a message" value="hello there friend">'
BOX_SENT = '[2]<textbox "Write a message">\n[9]<button "Attach">'


def make_exec(states, fail_actions=0):
    """List calls pop states in order (last repeats); actions succeed after
    fail_actions initial failures; everything is recorded."""
    calls = {"lists": 0, "acts": [], "fails_left": fail_actions}
    seq = list(states)

    async def execute(tool, params, bid, tid):
        if tool == "BrowserListInteractives":
            i = min(calls["lists"], len(seq) - 1)
            calls["lists"] += 1
            return {"text": seq[i], "url": "https://site.test/page"}
        calls["acts"].append((tool, params))
        if calls["fails_left"] > 0:
            calls["fails_left"] -= 1
            return {"error": "click failed"}
        return {"ok": True}
    return execute, calls


@pytest.mark.asyncio
async def test_click_verifies_specific_effect():
    """Click 'Options' expecting the menu to appear; before lacks it, after has it."""
    ex, calls = make_exec([MENU_CLOSED, MENU_OPEN])
    step = vs.VerifiedStep(kind="click", target="Options", role="button",
                           expect="appeared:Delete draft")
    r = await vs.run_verified_step(step, "b1", "", ex, settle_s=0)
    assert r == {"ok": True, "verified": True, "acted": True, "note": ""}
    assert calls["acts"][0][1]["index"] == 5  # resolved late against the live list


@pytest.mark.asyncio
async def test_reversible_miss_reaims_in_code():
    """First click produces no effect (stale page); the loop re-resolves and re-acts
    WITHOUT an LLM turn, and the second attempt verifies."""
    ex, calls = make_exec([MENU_CLOSED, MENU_CLOSED, MENU_CLOSED, MENU_OPEN])
    step = vs.VerifiedStep(kind="click", target="Options", expect="appeared:Delete draft")
    r = await vs.run_verified_step(step, "b1", "", ex, settle_s=0, max_reaim=1)
    assert r["ok"] is True
    assert len(calls["acts"]) == 2  # acted twice: the re-aim, not a model turn


@pytest.mark.asyncio
async def test_irreversible_never_refires_when_unverified():
    """A send-class step acts once, the effect can't be verified -> honest note,
    exactly ONE action ever dispatched."""
    ex, calls = make_exec([BOX_FILLED, BOX_FILLED, BOX_FILLED])
    step = vs.VerifiedStep(kind="click", target="Send", role="button",
                           expect="cleared:hello there friend", irreversible=True)
    r = await vs.run_verified_step(step, "b1", "", ex, settle_s=0, max_reaim=3)
    assert r["ok"] is False and r["acted"] is True
    assert "do NOT repeat" in r["note"]
    assert len(calls["acts"]) == 1  # the invariant: one irreversible dispatch, ever


@pytest.mark.asyncio
async def test_irreversible_errored_action_stops_clean():
    """An irreversible action that ERRORS provably never ran; stop without retry."""
    ex, calls = make_exec([BOX_FILLED], fail_actions=1)
    step = vs.VerifiedStep(kind="click", target="Send", irreversible=True)
    r = await vs.run_verified_step(step, "b1", "", ex, settle_s=0)
    assert r == {"ok": False, "verified": False, "acted": False, "note": "action errored: click failed"}
    assert len(calls["acts"]) == 1


@pytest.mark.asyncio
async def test_fill_defaults_to_filled_expectation():
    ex, calls = make_exec([BOX_EMPTY, BOX_FILLED])
    step = vs.VerifiedStep(kind="fill", target="Write a message", role="textbox",
                           text="hello there friend")
    r = await vs.run_verified_step(step, "b1", "", ex, settle_s=0)
    assert r["ok"] is True
    assert calls["acts"][0][1] == {"index": 2, "text": "hello there friend"}


@pytest.mark.asyncio
async def test_click_falls_to_by_name_when_index_unresolved():
    """Target absent from the capped list (the overlay-Send lesson): the act goes
    through click-by-name's full-DOM search instead of failing."""
    ex, calls = make_exec([BOX_FILLED, BOX_SENT])
    step = vs.VerifiedStep(kind="click", target="Send", role="button",
                           expect="cleared:hello there friend", irreversible=True)
    r = await vs.run_verified_step(step, "b1", "", ex, settle_s=0)
    assert r["ok"] is True
    assert calls["acts"][0] == ("BrowserClickByName", {"name": "Send", "role": "button"})


@pytest.mark.asyncio
async def test_fill_with_unresolvable_field_hands_back():
    ex, calls = make_exec([MENU_CLOSED])
    step = vs.VerifiedStep(kind="fill", target="Write a message", text="hi")
    r = await vs.run_verified_step(step, "b1", "", ex, settle_s=0)
    assert r["acted"] is False and "could not resolve" in r["note"]
    assert not calls["acts"]
