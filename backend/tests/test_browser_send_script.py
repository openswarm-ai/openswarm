"""Send-script mechanism, verified without a live webview: real LinkedIn-shaped
interactives fixtures driven through a mock executor exercise the exact path the
live rig would (opener -> composer -> fill -> commit-check -> send -> clear-check),
plus every abort/honesty branch. The wall-clock a live run measures is not here;
the correctness the live run would prove is."""
import pytest

from backend.apps.agents.browser import browser_send_script as ss
from backend.apps.agents.browser.browser_agent import send_submit_index_in_state, payload_in_textbox

PROFILE = '[22]*<link "Tyler Chen Premium 1st">\n[50]*<link "Message">\n[51]<button "Follow">'
COMPOSER_EMPTY = '[2]<textbox "Write a message">\n[9]<button "Attach">'
COMPOSER_FILLED = '[2]<textbox "Write a message" value="[test] hello world r9-os">\n[14]<button "Send">'
COMPOSER_SENT = '[2]<textbox "Write a message">\n[9]<button "Attach">'  # cleared, Send gone
# The profile-overlay committed-fill (ground truth from probe r-dump): payload IS
# in the box but the Send button ranks OUT of the capped numbered list, so the
# script must fall back to click-by-name (how the model itself sends there).
COMPOSER_FILLED_NO_SEND = '[1]<textbox "I\'m looking for…">\n[24]<textbox "Write a message" value="[test] hello world r9-os">'

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
    r = await ss.run_send_script(task, "b1", "", state0, ex, send_submit_index_in_state,
                                 payload_in_textbox, current_url=url)
    return r, calls


FEED_URL = "https://www.linkedin.com/feed/"
NO_COMPOSER = '[1]<link "Home">\n[2]<button "Search">\n[3]<link "Jobs">'
X_COMPOSER = '[3]<textbox "Post your reply">\n[8]<button "Reply">'  # X, not LinkedIn


@pytest.mark.asyncio
async def test_surface_gate_declines_when_no_composer_in_perception():
    """STRUCTURAL gate: a page whose perception has no compose-shaped textbox and no
    messaging opener declines UNTOUCHED, regardless of URL, so the script never fires
    where a fill would land nowhere useful."""
    ex, calls = make_exec([COMPOSER_FILLED, COMPOSER_FILLED, COMPOSER_SENT])
    r = await ss.run_send_script(TASK, "b1", "", NO_COMPOSER, ex, send_submit_index_in_state,
                                 payload_in_textbox, payload_source=TASK, current_url=FEED_URL)
    assert r is None
    assert not calls["clicks"]


@pytest.mark.asyncio
async def test_surface_gate_fires_on_a_NON_linkedin_composer():
    """The whole generalization: the same send-script fires on ANY site whose perception
    carries a composer (here X's 'Post your reply'), no per-site URL gate, AND completes
    by clicking X's real submit button ('Reply') BY INDEX. Before the submit-vocabulary
    was generalized this only 'passed' because the mock succeeds on the by-name 'Send'
    fallback that doesn't exist on real X, so assert the real index path is taken."""
    X_FILLED = '[3]<textbox "Post your reply" value="[test] hello world r9-os">\n[8]<button "Reply">'
    X_SENT = '[3]<textbox "Post your reply">\n[1]<link "Home">'
    ex, calls = make_exec([X_FILLED, X_FILLED, X_SENT])
    r = await ss.run_send_script(TASK, "b1", "", X_COMPOSER, ex, send_submit_index_in_state,
                                 payload_in_textbox, payload_source=TASK,
                                 current_url="https://x.com/messages/123")
    assert r is not None and r["sent"] is True
    # the send went via BrowserClickIndex on X's real Reply submit (8), not the by-name 'Send' crutch
    assert ("BrowserClickIndex", {"index": 8}) in calls["clicks"]
    assert not any(t == "BrowserClickByName" for t, _ in calls["clicks"])


@pytest.mark.asyncio
async def test_surface_gate_allows_profile_overlay():
    """The profile /in/ overlay is winnable via click-by-name (ground truth: its Send
    ranks out of the list but is a real button), so it's back in scope, not declined."""
    ex, calls = make_exec([COMPOSER_FILLED_NO_SEND, COMPOSER_FILLED_NO_SEND, COMPOSER_SENT])
    r = await ss.run_send_script(TASK, "b1", "", COMPOSER_EMPTY, ex, send_submit_index_in_state,
                                 payload_in_textbox, payload_source=TASK, current_url=PROFILE_URL)
    assert r is not None and r["sent"] is True


@pytest.mark.asyncio
async def test_send_via_click_by_name_when_send_absent_from_ranked_list():
    """Ground truth (probe r-dump): the committed-fill state has the payload in the
    box but NO Send in the capped numbered list. The script falls back to
    click-by-name (the model's own send path there) and the receipt still passes."""
    ex, calls = make_exec([COMPOSER_FILLED_NO_SEND, COMPOSER_FILLED_NO_SEND, COMPOSER_SENT])
    r = await ss.run_send_script(TASK, "b1", "", COMPOSER_EMPTY, ex, send_submit_index_in_state,
                                 payload_in_textbox, payload_source=TASK, current_url=THREAD_URL)
    assert r is not None and r["sent"] is True
    # the send went through click-by-name, not an index click
    byname = [c for c in calls["clicks"] if c[0] == "BrowserClickByName"]
    assert byname and byname[0][1] == {"name": "Send", "role": "button"}


@pytest.mark.asyncio
async def test_opener_hop_full_success():
    """On a messaging THREAD-LIST page (full-page surface): script opens the
    conversation composer, fills, sees it commit, finds the late Send, clicks,
    sees it clear -> receipt passes."""
    # poll reads stay no-composer (PROFILE x3) -> opener path -> click Message -> composer appears
    r, calls = await run(TASK, PROFILE, [PROFILE, PROFILE, PROFILE, COMPOSER_EMPTY, COMPOSER_FILLED, COMPOSER_SENT])
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
                                 send_submit_index_in_state, payload_in_textbox,
                                 payload_source=TASK, current_url=THREAD_URL)
    assert r is not None and r["sent"] is True
    assert r["payload"] == "[test] hello world r9-os"


def test_dryrun_report_encodes_the_gate_funnel():
    """The coverage harness greps this one line for gate attribution: a staged composer
    reports composer=1, a bare page reports zeros, and armed/filled ride the booleans."""
    r = ss.dryrun_report(COMPOSER_EMPTY, armed=True, filled=True, url=THREAD_URL)
    assert "armed=1" in r and "composer=1" in r and "filled=1" in r and "textboxes=1" in r
    r0 = ss.dryrun_report(NO_COMPOSER, armed=False, filled=False)
    assert "armed=0" in r0 and "composer=0" in r0 and "opener=0" in r0 and "textboxes=0" in r0


def test_dryrun_report_counts_unmatched_textboxes():
    """The X 'Post text' class: a textbox present but name-unmatched must be visible in
    the report (textboxes>0, composer=0), or the funnel can't tell R from N failures."""
    state = '[4]<textbox "Some Novel Label">\n[7]<button "Go">'
    r = ss.dryrun_report(state, armed=True, filled=False)
    assert "composer=0" in r and "textboxes=1" in r


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
                                 send_submit_index_in_state, payload_in_textbox,
                                 payload_source=TASK, current_url=THREAD_URL)
    assert r is None
    assert not calls["clicks"]


def test_looks_like_login_wall_hits_and_false_positives():
    # login/auth URLs (the live instagram/threads mis-fire was one of these)
    assert ss.looks_like_login_wall("https://www.instagram.com/accounts/login/?force_authentication", "")
    assert ss.looks_like_login_wall("https://accounts.google.com/v3/signin/identifier", "")
    assert ss.looks_like_login_wall("https://www.reddit.com/login/", "")
    assert ss.looks_like_login_wall("https://x.com/i/flow/login", "")
    # auth-form perception signals with an innocuous url
    assert ss.looks_like_login_wall("https://site.com/x", '[3]<textbox "Password">')
    assert ss.looks_like_login_wall("https://site.com/x", "Log in to X to continue")
    # false positives: a real composer page, a blog path, gmail inbox, a /author/ path
    assert not ss.looks_like_login_wall("https://x.com/home", X_COMPOSER)
    assert not ss.looks_like_login_wall("https://example.com/blog/login-tips", "")
    assert not ss.looks_like_login_wall("https://mail.google.com/mail/u/0/#inbox?compose=new", "")
    assert not ss.looks_like_login_wall("https://site.com/author/jane", "")


@pytest.mark.asyncio
async def test_login_wall_url_declines_before_any_fill():
    """A login URL declines even when the perception carries a composer and the task quotes a
    payload: a real send surface never shares a page with a login wall, and filling here types
    into the auth form (the live instagram/threads mis-fire under the reveal finder)."""
    ex, calls = make_exec([X_COMPOSER])
    r = await ss.run_send_script('post this exactly: "hello from the test x9"', "b1", "", X_COMPOSER, ex,
                                 send_submit_index_in_state, payload_in_textbox,
                                 current_url="https://x.com/i/flow/login")
    assert r is None
    assert not calls["clicks"]
