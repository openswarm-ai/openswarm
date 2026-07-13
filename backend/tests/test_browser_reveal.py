"""Structural composer finder + reveal-and-find reach + cross-nav retry, verified without a
live webview: a mock executor scripts BrowserFindComposer results so the send-script's
structural fallback path (find -> reveal -> re-perceive-on-nav -> fill) is exercised end to
end, including the flag gating and the safety that reveal only forwards under the flag."""
import pytest

from backend.apps.agents.browser import browser_send_script as ss
from backend.apps.agents.browser.browser_agent import send_index_in_state, payload_in_textbox

TASK = "go to tyler chen's linkedin hes in entrepreneurs first and text him '[test] hello world r9-os'"
NAMELESS = '[1]<link "Home">\n[2]<button "Search">'  # no name-matched composer, no opener


def make_struct_exec(fc_result, list_states=None):
    """execute_tool mock for the structural-finder path: list calls return no-composer
    states; a BrowserFindComposer call returns the scripted structural result."""
    calls = {"clicks": [], "find": 0}
    states = list(list_states or [NAMELESS] * 6)
    i = {"n": 0}

    # fc_result may be a single dict (returned every call) or a list of dicts (returned in
    # sequence, last one repeating) to script the cross-nav retry.
    fc_seq = fc_result if isinstance(fc_result, list) else [fc_result]

    async def execute(tool, params, bid, tid):
        if tool == "BrowserListInteractives":
            s = states[min(i["n"], len(states) - 1)]
            i["n"] += 1
            return {"text": s}
        if tool == "BrowserFindComposer":
            r = fc_seq[min(calls["find"], len(fc_seq) - 1)]
            calls["find"] += 1
            calls["clicks"].append((tool, params))
            return r
        calls["clicks"].append((tool, params))
        return {"ok": True}
    return execute, calls


@pytest.mark.asyncio
async def test_structural_finder_fills_when_name_detector_misses(monkeypatch):
    """The generalization: no AX-named composer and no opener, but the in-page finder
    ranks an editable region, fills + reads it back, and the script reports filled-ready
    (dry-run stops before the send). This is what unblocks Reddit-style contenteditables."""
    monkeypatch.setenv("OSW_COMPOSER_STRUCT", "1")
    monkeypatch.setenv("OSW_SENDSCRIPT_DRYRUN", "1")
    ex, calls = make_struct_exec({"found": True, "filled": True, "role": "contenteditable",
                                  "selector": '[data-osw-composer="1"]', "score": 6.2, "nearSubmit": True})
    r = await ss.run_send_script(TASK, "b1", "", NAMELESS, ex, send_index_in_state,
                                 payload_in_textbox, payload_source=TASK,
                                 current_url="https://www.reddit.com/r/test/comments/x/")
    assert r is not None and r["sent"] is False           # filled, stopped before the send
    assert calls["find"] == 1
    assert any(c[0] == "BrowserFindComposer" for c in calls["clicks"])


@pytest.mark.asyncio
async def test_structural_finder_declines_when_no_editable(monkeypatch):
    """The finder honestly finds nothing usable (a page with only a search box) -> decline
    to the model path, never a false fire."""
    monkeypatch.setenv("OSW_COMPOSER_STRUCT", "1")
    ex, calls = make_struct_exec({"found": False})
    r = await ss.run_send_script(TASK, "b1", "", NAMELESS, ex, send_index_in_state,
                                 payload_in_textbox, payload_source=TASK, current_url="https://example.com/")
    assert r is None
    assert calls["find"] == 1


@pytest.mark.asyncio
async def test_structural_off_by_default_never_calls_finder(monkeypatch):
    """Flag off = the proven name path only; a name-less perception declines and the finder
    is never invoked (the structural path can't perturb the default)."""
    monkeypatch.delenv("OSW_COMPOSER_STRUCT", raising=False)
    ex, calls = make_struct_exec({"found": True, "filled": True, "selector": "x", "role": "textarea"})
    r = await ss.run_send_script(TASK, "b1", "", NAMELESS, ex, send_index_in_state,
                                 payload_in_textbox, payload_source=TASK, current_url="https://example.com/")
    assert r is None
    assert calls["find"] == 0


@pytest.mark.asyncio
async def test_reveal_flag_passed_to_finder_when_enabled(monkeypatch):
    """OSW_COMPOSER_REVEAL=1 lets the finder take a reversible reveal action: the send-script
    must forward reveal=True to BrowserFindComposer (the composer isn't painted yet)."""
    monkeypatch.setenv("OSW_COMPOSER_STRUCT", "1")
    monkeypatch.setenv("OSW_COMPOSER_REVEAL", "1")
    monkeypatch.setenv("OSW_SENDSCRIPT_DRYRUN", "1")
    ex, calls = make_struct_exec({"found": True, "filled": True, "role": "contenteditable",
                                  "selector": '[data-osw-composer="1"]', "score": 6.0,
                                  "nearSubmit": True, "reveals": ["trigger"]})
    r = await ss.run_send_script(TASK, "b1", "", NAMELESS, ex, send_index_in_state,
                                 payload_in_textbox, payload_source=TASK,
                                 current_url="https://www.linkedin.com/feed/")
    assert r is not None and r["sent"] is False
    find_call = next(c for c in calls["clicks"] if c[0] == "BrowserFindComposer")
    assert find_call[1].get("reveal") is True


@pytest.mark.asyncio
async def test_cross_nav_retry_after_open_first_navigates(monkeypatch):
    """open-first reveal navigates to the item page (killing the finder's context) so the first
    call finds nothing; the send-script re-perceives and calls the finder a SECOND time on the
    destination, where the composer now fills. Proves the cross-nav retry."""
    monkeypatch.setenv("OSW_COMPOSER_STRUCT", "1")
    monkeypatch.setenv("OSW_COMPOSER_REVEAL", "1")
    monkeypatch.setenv("OSW_SENDSCRIPT_DRYRUN", "1")
    seq = [
        {"found": False, "reveals": ["trigger:noop", "open-first", "scroll"]},   # navigated away
        {"found": True, "filled": True, "role": "contenteditable",
         "selector": '[data-osw-composer="1"]', "score": 6.0, "reveals": ["scroll"]},
    ]
    ex, calls = make_struct_exec(seq)
    r = await ss.run_send_script(TASK, "b1", "", NAMELESS, ex, send_index_in_state,
                                 payload_in_textbox, payload_source=TASK,
                                 current_url="https://www.reddit.com/r/test")
    assert r is not None and r["sent"] is False
    assert calls["find"] == 2                       # retried on the destination


@pytest.mark.asyncio
async def test_cross_nav_no_retry_when_reveal_did_not_navigate(monkeypatch):
    """If the finder did NOT fire open-first (a same-doc trigger/scroll that just failed), there
    is no destination to re-perceive, so it declines after ONE call, no wasted retry."""
    monkeypatch.setenv("OSW_COMPOSER_STRUCT", "1")
    monkeypatch.setenv("OSW_COMPOSER_REVEAL", "1")
    ex, calls = make_struct_exec({"found": False, "reveals": ["trigger:noop", "open-first:noop", "scroll"]})
    r = await ss.run_send_script(TASK, "b1", "", NAMELESS, ex, send_index_in_state,
                                 payload_in_textbox, payload_source=TASK, current_url="https://example.com/")
    assert r is None
    assert calls["find"] == 1


@pytest.mark.asyncio
async def test_reveal_flag_off_by_default(monkeypatch):
    """Struct on but reveal unset: the finder is still called, but reveal=False, so it only
    scans what's painted and never clicks a trigger (the safe default)."""
    monkeypatch.setenv("OSW_COMPOSER_STRUCT", "1")
    monkeypatch.delenv("OSW_COMPOSER_REVEAL", raising=False)
    ex, calls = make_struct_exec({"found": False})
    await ss.run_send_script(TASK, "b1", "", NAMELESS, ex, send_index_in_state,
                             payload_in_textbox, payload_source=TASK, current_url="https://example.com/")
    find_call = next(c for c in calls["clicks"] if c[0] == "BrowserFindComposer")
    assert find_call[1].get("reveal") is False
