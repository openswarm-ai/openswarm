"""Send-script mechanism, verified without a live webview: real LinkedIn-shaped
interactives fixtures driven through a mock executor exercise the exact path the
live rig would (opener -> composer -> fill -> commit-check -> send -> clear-check),
plus every abort/honesty branch. The wall-clock a live run measures is not here;
the correctness the live run would prove is."""
import pytest

from backend.apps.agents.browser import browser_send_script as ss
from backend.apps.agents.browser.browser_agent import send_index_in_state, payload_in_textbox

PROFILE = '[22]*<link "Tyler Chen Premium 1st">\n[50]*<link "Message">\n[51]<button "Follow">'
COMPOSER_EMPTY = '[2]<textbox "Write a message">\n[9]<button "Attach">'
COMPOSER_FILLED = '[2]<textbox "Write a message" value="[test] hello world r9-os">\n[14]<button "Send">'
COMPOSER_SENT = '[2]<textbox "Write a message">\n[9]<button "Attach">'  # cleared, Send gone

TASK = "go to tyler chen's linkedin hes in entrepreneurs first and text him '[test] hello world r9-os'"


def make_exec(list_script):
    """execute_tool mock: each BrowserListInteractives call returns the next
    scripted state; clicks/fills succeed and are recorded."""
    calls = {"list": 0, "clicks": []}
    states = list(list_script)

    async def execute(tool, params, bid, tid):
        if tool == "BrowserListInteractives":
            i = min(calls["list"], len(states) - 1)
            calls["list"] += 1
            return {"text": states[i]}
        calls["clicks"].append((tool, params))
        return {"ok": True}
    return execute, calls


# A full-page messaging composer: the only surface the script fires on (the live
# A/B proved firing on the profile /in/ overlay is net-negative). Tests that exercise
# the fill/send mechanism pass this; the surface-gate test passes the overlay URL.
THREAD_URL = "https://www.linkedin.com/messaging/thread/2-abc/"
PROFILE_URL = "https://www.linkedin.com/in/tylerchen1200/"


async def run(task, state0, list_script, url=THREAD_URL):
    ex, calls = make_exec(list_script)
    r = await ss.run_send_script(task, "b1", "", state0, ex, send_index_in_state,
                                 payload_in_textbox, current_url=url)
    return r, calls


@pytest.mark.asyncio
async def test_surface_gate_declines_profile_overlay():
    """The live A/B (r246-r251) proved firing on the profile /in/ docked-overlay is
    net-negative: fill commits, overlay Send never lists, abort, and the half-staged
    handoff ran 4x slower than a clean model run. So a profile URL declines UNTOUCHED."""
    ex, calls = make_exec([COMPOSER_FILLED, COMPOSER_FILLED, COMPOSER_SENT])
    r = await ss.run_send_script(TASK, "b1", "", COMPOSER_EMPTY, ex, send_index_in_state,
                                 payload_in_textbox, payload_source=TASK, current_url=PROFILE_URL)
    assert r is None
    assert not calls["clicks"]  # nothing touched, model gets a clean composer


@pytest.mark.asyncio
async def test_opener_hop_full_success():
    """On a messaging THREAD-LIST page (full-page surface): script opens the
    conversation composer, fills, sees it commit, finds the late Send, clicks,
    sees it clear -> receipt passes."""
    r, calls = await run(TASK, PROFILE, [COMPOSER_EMPTY, COMPOSER_FILLED, COMPOSER_FILLED, COMPOSER_SENT])
    assert r is not None and r["sent"] is True
    assert r["payload"] == "[test] hello world r9-os"
    # opener click (50), fill into composer (2 w/ text), solo send click (14)
    idxs = [c[1].get("index") for c in calls["clicks"]]
    assert 50 in idxs and 2 in idxs and 14 in idxs
    fill = next(c for c in calls["clicks"] if c[1].get("text"))
    assert fill[1]["text"] == "[test] hello world r9-os"


@pytest.mark.asyncio
async def test_composer_already_open_skips_opener():
    """Prestage left the composer open: no opener click, straight to fill+send."""
    r, calls = await run(TASK, COMPOSER_EMPTY, [COMPOSER_FILLED, COMPOSER_FILLED, COMPOSER_SENT])
    assert r is not None and r["sent"] is True
    assert 50 not in [c[1].get("index") for c in calls["clicks"]]  # never clicked an opener


@pytest.mark.asyncio
async def test_abort_when_no_payload():
    """No quoted payload = the model's judgment call, never the script's."""
    r, _ = await run("open tyler chen's linkedin and message him something nice", PROFILE,
               [COMPOSER_EMPTY])
    assert r is None


@pytest.mark.asyncio
async def test_abort_when_fill_not_seen_committed():
    """Fill click ran but the textbox never shows the payload -> abort PRE-click,
    the irreversible send never fires (no false 'sent')."""
    r, calls = await run(TASK, COMPOSER_EMPTY, [COMPOSER_EMPTY, COMPOSER_EMPTY, COMPOSER_EMPTY])
    assert r is None
    # a Send-class click (index 14) must NEVER have been issued
    assert all(c[1].get("index") != 14 for c in calls["clicks"])


@pytest.mark.asyncio
async def test_post_click_unverified_yields_honest_note_not_resend():
    """Send clicked but the composer never verifiably clears -> the run returns
    sent=False with a do-not-resend note, never a silent retry."""
    r, calls = await run(TASK, COMPOSER_EMPTY, [COMPOSER_FILLED, COMPOSER_FILLED,
                                          COMPOSER_FILLED, COMPOSER_FILLED, COMPOSER_FILLED])
    assert r is not None and r["sent"] is False
    assert "do NOT send again" in r["note"] or "not send again" in r["note"].lower()
    # exactly one send-class click was issued (no blind re-fire)
    assert sum(1 for c in calls["clicks"] if c[1].get("index") == 14) == 1


@pytest.mark.asyncio
async def test_ambiguous_opener_aborts():
    """Two 'Message' openers = ambiguous = hands to the model, no guess."""
    two = '[50]*<link "Message">\n[70]*<link "Message">'
    r, _ = await run(TASK, two, [COMPOSER_EMPTY])
    assert r is None


COMPOSED = (
    f"{TASK}\n\n"
    "[routing brief from a fast pre-pass; follow it unless the live page disagrees]\n"
    'ENTRY: https://www.linkedin.com/search/results/people/\nSTEPS: click the "Tyler Chen" result, '
    'then the "Message" button, type the text, click "Send"'
)


@pytest.mark.asyncio
async def test_composed_task_brief_quotes_fire_via_payload_source():
    """The routing brief's own quoted strings made the payload ambiguous on every
    real dispatch (r242/r243 declined live); the raw user prompt rides separately."""
    ex, calls = make_exec([COMPOSER_FILLED, COMPOSER_FILLED, COMPOSER_SENT])
    r = await ss.run_send_script(COMPOSED, "b1", "", COMPOSER_EMPTY, ex,
                                 send_index_in_state, payload_in_textbox,
                                 payload_source=TASK, current_url=THREAD_URL)
    assert r is not None and r["sent"] is True
    assert r["payload"] == "[test] hello world r9-os"


@pytest.mark.asyncio
async def test_readonly_probe_never_fires():
    """The send-probe quotes the very payload it checks for; without this wall the
    script DELIVERED a real message from a read-only probe (r243 live)."""
    probe = (
        "READ-ONLY verification, do NOT send, type, click any send/submit control. "
        'Check the thread for this exact text:\n"[test] hello world r9-os"\n'
        "End with OUTCOME: PAYLOAD-FOUND or PAYLOAD-NOT-FOUND."
    )
    ex, calls = make_exec([COMPOSER_FILLED, COMPOSER_FILLED, COMPOSER_SENT])
    r = await ss.run_send_script(probe, "b1", "", COMPOSER_EMPTY, ex,
                                 send_index_in_state, payload_in_textbox,
                                 payload_source=TASK, current_url=THREAD_URL)
    assert r is None
    assert not calls["clicks"]
