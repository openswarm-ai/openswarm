"""End-to-end integration test of the real browser agent loop.

Drives run_browser_agent() with only the two external boundaries faked: the LLM
client (scripted tool calls) and the browser executor (scripted results). Proves
the four ported behaviors fire together in the actual loop, not just in isolation:
  - goal threading into BrowserListInteractives,
  - deterministic stagnation nudges,
  - exactly-once aux-LLM adjudication at exhaustion,
  - per-domain hints written, then seeded into the system prompt next run.
"""

import asyncio
import json
import uuid

from backend.apps.agents.browser import browser_agent as BA
from backend.apps.agents.browser import browser_history as BH


# --- fake Anthropic-shaped objects -----------------------------------------
class Blk:
    def __init__(self, type, text=None, id=None, name=None, input=None):
        self.type = type; self.text = text; self.id = id; self.name = name; self.input = input


class Resp:
    def __init__(self, content, stop_reason="tool_use"):
        self.content = content
        self.stop_reason = stop_reason
        self.usage = type("U", (), {"input_tokens": 1, "output_tokens": 1})()


class FakeStream:
    # mirrors anthropic's messages.stream(): async CM whose get_final_message() returns the turn
    def __init__(self, resp): self.resp = resp
    async def __aenter__(self): return self
    async def __aexit__(self, *a): return False
    async def get_final_message(self): return self.resp


class FakeLLM:
    def __init__(self, scripted):
        self.scripted = scripted; self.turn = 0; self.calls = []
        self.messages = self

    def p_next(self, kw):
        self.calls.append(kw)
        i = min(self.turn, len(self.scripted) - 1)
        self.turn += 1
        return self.scripted[i]

    async def create(self, **kw):
        return self.p_next(kw)

    def stream(self, **kw):
        # the loop now streams; return an async-CM yielding the scripted turn
        return FakeStream(self.p_next(kw))


class FakeAux:
    def __init__(self):
        self.calls = []
        self.messages = self

    async def create(self, **kw):
        self.calls.append(kw)
        return Resp([Blk("text", "Try BrowserListInteractives then BrowserClickIndex.")], stop_reason="end_turn")


def p_tu(name, **inp):
    return Blk("tool_use", id="t" + uuid.uuid4().hex[:8], name=name, input=inp)


def p_rp(goal, mem="Share dialog is a cross-origin iframe; use the index list."):
    return p_tu("ReportProgress", evaluation_previous="prev", working_memory=mem, next_goal=goal)


DOC_URL = "https://docs.google.com/document/d/abc/edit"


def p_run_settled(**kw):
    """run_browser_agent then drain the backgrounded learning task; the distill
    no longer blocks the reply path, so tests asserting its effects must settle it."""
    async def p_go():
        r = await BA.run_browser_agent(**kw)
        if BA.p_learn_tasks:
            await asyncio.gather(*list(BA.p_learn_tasks), return_exceptions=True)
        return r
    return asyncio.run(p_go())


def p_install(monkeypatch, primary, aux):
    # local imports inside run_browser_agent resolve from these source modules
    import backend.apps.settings.settings as settings_mod
    import backend.apps.settings.credentials as cred_mod
    import backend.apps.agents.providers.registry as reg_mod
    import backend.apps.agents.agent_manager as am_mod

    monkeypatch.setattr(settings_mod, "load_settings", lambda: {"fake": True}, raising=True)
    # a dict (not object()) so get_api_type's (entry or {}).get("api") works like the real registry rows
    monkeypatch.setattr(reg_mod, "find_builtin_model", lambda m: {"api": "anthropic"}, raising=True)
    monkeypatch.setattr(reg_mod, "resolve_model_id_for_sdk", lambda m, s: "primary-x", raising=True)

    async def p_aux_resolve(s, preferred_tier="haiku", primary_api=None):
        return ("aux-x", None)
    monkeypatch.setattr(reg_mod, "resolve_aux_model", p_aux_resolve, raising=True)

    def p_client_for(s, model):
        return aux if model == "aux-x" else primary
    monkeypatch.setattr(cred_mod, "get_anthropic_client_for_model", p_client_for, raising=True)

    monkeypatch.setattr(BA, "load_builtin_permissions", lambda: {}, raising=True)

    # fake WS: record browser commands, script results by action
    sent = []

    async def p_send_browser_command(request_id, action, browser_id, params, tab_id=""):
        sent.append({"action": action, "params": params})
        # smart-wait probes via evaluate; report 'settled' so BrowserWait returns fast in tests instead of riding the full cap.
        if action == "evaluate" and "getEntriesByType('resource')" in str(params.get("expression", "")):
            expr = str(params.get("expression", ""))
            # a confirm/target probe embeds a non-empty `const spec="..."`; report it found
            found = "const spec=" in expr and 'const spec=""' not in expr
            return {"text": json.dumps({"ready": True, "quiet": 9999, "elems": 100, "found": found}), "url": DOC_URL}
        # generic evaluate echoes its expression so distinct reads yield distinct results (lets a test exercise new-data-each-turn gather vs spinning)
        if action == "evaluate":
            return {"text": f"eval:{str(params.get('expression',''))[:120]}", "url": DOC_URL}
        if action == "list_interactives":
            # a non-irreversible label on purpose: Send/Submit-named steps are refused by the replay send-gate, which has its own test below
            return {"text": '1 interactive elements:\n[1]<button "Search">', "url": DOC_URL}
        if action == "click_index":
            # frontend surfaces the clicked element's role/name for skill recording; index 99 is the test sentinel for the irreversible "Send" button
            p_nm = "Send" if params.get("index") == 99 else "Search"
            return {"text": f"Clicked index {params.get('index')}", "url": DOC_URL, "clickedRole": "button", "clickedName": p_nm}
        if action == "click_by_name":
            return {"text": f'Clicked button "{params.get("name")}"', "url": DOC_URL}
        if action == "click":
            return {"error": "Element not found: '.submit'"}
        if action == "navigate":
            return {"text": "Navigated", "url": params.get("url", DOC_URL)}
        if action == "screenshot":
            return {"text": "shot"}
        if action == "detect_webmcp":
            return {"text": "No WebMCP on this page.", "url": DOC_URL}
        if action == "list_routes":
            return {"text": "Replayable API routes:\nGET https://docs.google.com/api/docs (x3)", "url": DOC_URL}
        if action == "replay_route":
            return {"text": f"GET {params.get('url')} -> HTTP 200\n{{\"docs\": []}}", "status": 200, "url": DOC_URL}
        return {"text": "ok", "url": DOC_URL}

    async def p_noop(*a, **k):
        return None

    monkeypatch.setattr(BA.ws_manager, "send_browser_command", p_send_browser_command, raising=False)
    monkeypatch.setattr(BA.ws_manager, "send_to_session", p_noop, raising=False)
    return sent


def test_full_loop_goal_stagnation_adjudication_and_hint_write(monkeypatch):
    BH.BROWSER_HISTORY.clear(); BH.DOMAIN_NOTES.clear()
    primary = FakeLLM([
        Resp([p_rp("click the Search button"), p_tu("BrowserListInteractives")]),
        Resp([p_rp("click submit"), p_tu("BrowserClick", selector=".s1")]),
        Resp([p_rp("retry"), p_tu("BrowserClick", selector=".s2")]),
        Resp([p_rp("retry"), p_tu("BrowserClick", selector=".s3")]),
        Resp([p_rp("retry"), p_tu("BrowserClick", selector=".s4")]),
        Resp([p_rp("retry"), p_tu("BrowserClick", selector=".s5")]),
        Resp([Blk("text", "Giving up cleanly.")], stop_reason="end_turn"),
    ])
    aux = FakeAux()
    sent = p_install(monkeypatch, primary, aux)

    result = asyncio.run(BA.run_browser_agent(
        task="Share the doc with someone", browser_id="b1", model="sonnet",
    ))
    assert result["browser_id"] == "b1"

    # 1) goal threaded into the loop's list_interactives call (a no-goal perception front-load may precede it now, so assert SOME call carries the goal)
    list_calls = [c for c in sent if c["action"] == "list_interactives"]
    assert any(c["params"].get("goal") == "click the Search button" for c in list_calls)

    # 2) stagnation nudge injected into a tool_result (seen by a later LLM turn)
    all_msgs = json.dumps([c["messages"] for c in primary.calls])
    assert "NO PROGRESS" in all_msgs

    # 3) aux adjudication fired EXACTLY once, at exhaustion, and was injected
    assert len(aux.calls) == 1
    assert "Suggested next step" in all_msgs

    # 4) per-domain hint written from working_memory
    assert "cross-origin iframe" in BH.get_domain_note("google.com")


def test_action_with_expect_is_confirmed(monkeypatch):
    # An action that declares `expect` is CONFIRMED after it runs: the loop issues a target-aware confirm probe and feeds the next turn a tool_result stating the expected change is present (observed success, never assumed).
    BH.BROWSER_HISTORY.clear(); BH.DOMAIN_NOTES.clear()
    primary = FakeLLM([
        Resp([p_rp("click submit and confirm"),
              p_tu("BrowserClickIndex", index=1, expect="Submitted")]),
        Resp([Blk("text", "Confirmed and done.")], stop_reason="end_turn"),
    ])
    aux = FakeAux()
    sent = p_install(monkeypatch, primary, aux)

    asyncio.run(BA.run_browser_agent(task="submit the form", browser_id="b1", model="sonnet"))

    # a confirm probe carrying the declared target was issued
    assert any(c["action"] == "evaluate" and "Submitted" in str(c["params"].get("expression", ""))
               for c in sent), "no confirm probe for the declared target"
    # and the confirmation was fed back to the model on the next turn
    all_msgs = json.dumps([c["messages"] for c in primary.calls])
    assert "Confirmed: 'Submitted' is now present." in all_msgs


def test_missing_report_progress_runs_the_action_and_reminds_not_rejects(monkeypatch):
    # The model acts WITHOUT ReportProgress. Old behavior rejected the turn (wasted a round-trip); new behavior runs the action and folds in a one-line reminder.
    BH.BROWSER_HISTORY.clear(); BH.DOMAIN_NOTES.clear()
    primary = FakeLLM([
        Resp([p_tu("BrowserClickIndex", index=2)]),  # NO ReportProgress this turn
        Resp([Blk("text", "done")], stop_reason="end_turn"),
    ])
    aux = FakeAux()
    sent = p_install(monkeypatch, primary, aux)

    asyncio.run(BA.run_browser_agent(task="click result two", browser_id="b1", model="sonnet"))

    # the action actually executed (a click_index reached the browser), not rejected
    assert any(c["action"] == "click_index" for c in sent), "the action was not run"
    # the model was reminded (folded onto the result), never told 'REJECTED'
    all_msgs = json.dumps([c["messages"] for c in primary.calls])
    assert "include ReportProgress" in all_msgs
    assert "REJECTED" not in all_msgs


def test_confirmed_send_ends_the_run_instead_of_stalling(monkeypatch):
    # After an irreversible send CONFIRMS, the model must not burn turns re-verifying. Here it sends (index 99 = "Send", expect confirms) then tries to stall forever with pure-perception turns; the loop must END within a turn or two, not spin.
    BH.BROWSER_HISTORY.clear(); BH.DOMAIN_NOTES.clear()
    primary = FakeLLM([
        Resp([p_rp("send the message"), p_tu("BrowserClickIndex", index=99, expect="Sent")]),
        # the model now STALLS, re-looking instead of finishing (the bug)
        *[Resp([p_rp("double-check it sent"), p_tu("BrowserScreenshot")]) for _ in range(8)],
        Resp([Blk("text", "OUTCOME: DONE - sent")], stop_reason="end_turn"),
    ])
    aux = FakeAux()
    sent = p_install(monkeypatch, primary, aux)

    result = asyncio.run(BA.run_browser_agent(task="text Tyler hello", browser_id="b1", model="sonnet"))

    # the send ran and the run ended FAST (the stall guard stopped it), well before consuming all 8 scripted stall turns
    assert any(c["action"] == "click_index" and c["params"].get("index") == 99 for c in sent)
    assert primary.turn <= 4, f"run stalled {primary.turn} turns after a confirmed send"
    # structured success + a clean human summary, never the internal tag
    assert result.get("done") is True
    assert "OUTCOME" not in result["summary"]
    assert result["summary"].strip()


def test_done_tool_delivers_a_clean_human_summary(monkeypatch):
    # Canonical finish: the model calls Done(message); that message is the user's reply verbatim (no OUTCOME tag, no UI mechanics) and `done` is True.
    BH.BROWSER_HISTORY.clear(); BH.DOMAIN_NOTES.clear()
    primary = FakeLLM([
        Resp([p_rp("open profile + send"), p_tu("BrowserClickIndex", index=5, expect="Sent")]),
        Resp([p_tu("Done", message="Sent your message to Tyler, it's in the thread now.")]),
    ])
    aux = FakeAux()
    p_install(monkeypatch, primary, aux)
    result = asyncio.run(BA.run_browser_agent(task="text Tyler hello", browser_id="b1", model="sonnet"))
    assert result["summary"] == "Sent your message to Tyler, it's in the thread now."
    assert result.get("done") is True
    assert "OUTCOME" not in result["summary"]


def test_done_tool_success_false_marks_not_done(monkeypatch):
    # Done(success=false) is the honest "couldn't finish": done is False so the fast path knows to recover, and the message still reads like a person wrote it.
    BH.BROWSER_HISTORY.clear(); BH.DOMAIN_NOTES.clear()
    primary = FakeLLM([
        Resp([p_rp("look for thread"), p_tu("BrowserClickIndex", index=3)]),
        Resp([p_tu("Done", message="I hit a login wall, so I couldn't open the chat.", success=False)]),
    ])
    aux = FakeAux()
    p_install(monkeypatch, primary, aux)
    result = asyncio.run(BA.run_browser_agent(task="text Tyler hello", browser_id="b1", model="sonnet"))
    assert result.get("done") is False
    assert "login wall" in result["summary"]


def test_run_that_never_calls_done_is_not_a_clean_success(monkeypatch):
    # A run that does real work but stops with plain text (never calls Done) is a half-finish, not a clean success: done must be False so the fast path recovers instead of shipping a silent stop (the 'Task completed.' that wasn't).
    BH.BROWSER_HISTORY.clear(); BH.DOMAIN_NOTES.clear()
    primary = FakeLLM([
        Resp([p_rp("click it"), p_tu("BrowserClickIndex", index=3)]),
        Resp([Blk("text", "I clicked the thing.")], stop_reason="end_turn"),
    ])
    aux = FakeAux()
    p_install(monkeypatch, primary, aux)
    result = asyncio.run(BA.run_browser_agent(task="open the settings page", browser_id="b1", model="sonnet"))
    assert result.get("done") is False  # no explicit Done -> not a clean success


def test_send_shortcut_does_not_arm_on_a_gather_task(monkeypatch):
    # The Airbnb bug: a send-class click (here the index-99 sentinel = "Send", same as a cookie "Accept all" tripping the detector) on a FIND/gather task must NOT arm the send-completion shortcut, there is no send to confirm. If it did, the run cuts at the 2-turn post-send limit and leaks the canned "message went through" line. On a gather task it should run the full perception budget.
    BH.BROWSER_HISTORY.clear(); BH.DOMAIN_NOTES.clear()
    primary = FakeLLM([
        Resp([p_rp("dismiss the cookie banner"), p_tu("BrowserClickIndex", index=99)]),
        *[Resp([p_rp("keep reading the list"), p_tu("BrowserScreenshot")]) for _ in range(8)],
        Resp([p_tu("Done", message="Here are the top items: a, b, c")]),
    ])
    aux = FakeAux()
    p_install(monkeypatch, primary, aux)
    result = asyncio.run(BA.run_browser_agent(task="find me the top 10 repos", browser_id="b1", model="sonnet"))
    # the send shortcut never armed: it ran past the 2-turn post-send cutoff toward the 6-turn perception budget, and no send-confirmation line leaked
    assert primary.turn >= 6, f"gather task cut short at turn {primary.turn} (send shortcut wrongly armed)"
    assert "went through" not in result["summary"]


def test_browser_save_data_writes_a_file_and_returns_a_receipt(monkeypatch, tmp_path):
    # BrowserSaveData should run the JS, write the result to a sandboxed file, and return a path receipt (NOT the data), so a big list lands in one step instead of a dozen reply-chunks. The mock's evaluate echoes its expression as the data.
    import os as p_os
    monkeypatch.setattr(p_os.path, "expanduser", lambda p: str(tmp_path))  # fallback workspace -> tmp
    BH.BROWSER_HISTORY.clear(); BH.DOMAIN_NOTES.clear()
    primary = FakeLLM([
        Resp([p_rp("save the rows"), p_tu("BrowserSaveData", expression="JSON.stringify(window.__rows)", filename="rows.json")]),
        Resp([p_tu("Done", message="Saved the full set to rows.json.")]),
    ])
    aux = FakeAux()
    p_install(monkeypatch, primary, aux)
    result = asyncio.run(BA.run_browser_agent(task="get every row and save it", browser_id="b1", model="sonnet"))
    # the file exists under the sandbox subdir, and the receipt (a tool_result) named a path
    saved = list(tmp_path.glob("**/browser-data/rows.json"))
    assert saved, "BrowserSaveData did not write the file"
    assert result.get("done") is True
    # The Airbnb regression: a page-by-page gather (a fresh Extract returning NEW listings every turn) must NOT trip the spin backstop, gathering is the work, not spinning. Here 9 straight Extract turns each return distinct data; the run should keep going (no early wrap-up nudge) and finish on the model's own Done.
    BH.BROWSER_HISTORY.clear(); BH.DOMAIN_NOTES.clear()
    primary = FakeLLM([
        # each turn reads a DIFFERENT page (distinct expression -> distinct result)
        *[Resp([p_rp(f"page {i}"), p_tu("BrowserEvaluate", expression=f"parsePage({i})")]) for i in range(9)],
        Resp([p_tu("Done", message="Gathered all pages: 250 listings. Airbnb caps SF at ~15 pages.")]),
    ])
    aux = FakeAux()
    p_install(monkeypatch, primary, aux)
    result = asyncio.run(BA.run_browser_agent(task="find me all the airbnbs in sf", browser_id="b1", model="sonnet"))
    # it ran the full gather (all 9 extract turns) and finished on its own Done, NOT cut short by a wrap-up nudge at turn 6
    assert primary.turn >= 9, f"gather cut short at turn {primary.turn} (new-data reads wrongly counted as spinning)"
    assert "Gathered all pages" in result["summary"]
    assert result.get("done") is True


def test_spin_backstop_nudges_a_clean_wrapup_instead_of_a_midthought(monkeypatch):
    # The Airbnb mid-thought bug: a read-heavy run that trips the spin backstop must get ONE wrap-up nudge to summarize via Done, not be cut off mid-sentence. The final reply is the model's clean Done answer, and the nudge actually reached it.
    BH.BROWSER_HISTORY.clear(); BH.DOMAIN_NOTES.clear()
    primary = FakeLLM([
        Resp([p_rp("open the list"), p_tu("BrowserClickIndex", index=3)]),   # an action arms the backstop
        # repeated identical screenshots (same result, no new data) = genuine spinning
        *[Resp([p_tu("BrowserScreenshot")]) for _ in range(10)],
        Resp([p_tu("Done", message="Here are the top repos: a, b, c")]),    # obeys the wrap-up nudge
    ])
    aux = FakeAux()
    p_install(monkeypatch, primary, aux)
    result = asyncio.run(BA.run_browser_agent(task="find me the top 10 repos", browser_id="b1", model="sonnet"))
    assert any("Wrap up NOW" in json.dumps(c["messages"]) for c in primary.calls), "wrap-up nudge not delivered"
    assert result["summary"] == "Here are the top repos: a, b, c"  # the model's answer, not a mid-thought
    assert result.get("done") is True


def test_early_perception_is_not_cut_short_before_any_action(monkeypatch):
    # Orienting on a cold/slow page can take several look-only turns; the stall backstop must NOT fire before the agent has done anything (it only bounds a POST-action spin). Here 7 perception turns precede the finish; all must run.
    BH.BROWSER_HISTORY.clear(); BH.DOMAIN_NOTES.clear()
    # varied read tools so the (separate) identical-repeat loop detector doesn't trip; this isolates the stall backstop, which must NOT fire pre-action
    p_reads = ["BrowserListInteractives", "BrowserGetText", "BrowserScreenshot"]
    primary = FakeLLM([
        *[Resp([p_rp("still orienting"), p_tu(p_reads[i % 3])]) for i in range(7)],
        Resp([Blk("text", "OUTCOME: NOT DONE - could not find it")], stop_reason="end_turn"),
    ])
    aux = FakeAux()
    p_install(monkeypatch, primary, aux)
    asyncio.run(BA.run_browser_agent(task="find the thing", browser_id="b1", model="sonnet"))
    # it ran all 8 scripted turns (was NOT force-ended at the 6-perception backstop)
    assert primary.turn >= 8, f"early orientation was cut short at turn {primary.turn}"


def test_aux_adjudication_fires_even_when_loop_detector_trips(monkeypatch):
    # Repeated IDENTICAL failing clicks trip the exact-repeat loop detector AND reach stagnation exhaustion on the same turn. The aux escape hatch must still fire (it was previously suppressed by the `not is_loop` guard).
    BH.BROWSER_HISTORY.clear(); BH.DOMAIN_NOTES.clear()
    primary = FakeLLM([
        Resp([p_rp("click submit"), p_tu("BrowserListInteractives")]),
        *[Resp([p_rp("retry same"), p_tu("BrowserClick", selector=".same")]) for _ in range(6)],
        Resp([Blk("text", "done")], stop_reason="end_turn"),
    ])
    aux = FakeAux()
    sent = p_install(monkeypatch, primary, aux)

    asyncio.run(BA.run_browser_agent(
        task="Share the doc", browser_id="b3", model="sonnet",
    ))
    all_msgs = json.dumps([c["messages"] for c in primary.calls])
    # the loop detector definitely tripped (identical tool+input+result)
    assert "LOOP DETECTED" in all_msgs
    # ...and the aux adjudication STILL fired exactly once despite that
    assert len(aux.calls) == 1
    assert "Suggested next step" in all_msgs


def test_tier1_and_tier2_tools_drive_through_the_real_loop(monkeypatch):
    # The agent can call the new tier-1 (WebMCP detect) and tier-2 (list/replay) tools through the actual run_browser_agent loop, and replay threads its url.
    BH.BROWSER_HISTORY.clear(); BH.DOMAIN_NOTES.clear()
    primary = FakeLLM([
        Resp([p_rp("check for a faster path"), p_tu("BrowserDetectWebMCP")]),
        Resp([p_rp("list captured routes"), p_tu("BrowserListRoutes")]),
        Resp([p_rp("replay the docs route"), p_tu("BrowserReplayRoute", url="https://docs.google.com/api/docs")]),
        Resp([Blk("text", "Got the data via the API.")], stop_reason="end_turn"),
    ])
    aux = FakeAux()
    sent = p_install(monkeypatch, primary, aux)

    asyncio.run(BA.run_browser_agent(
        task="Read my docs list", browser_id="b4", model="sonnet",
    ))
    actions = [c["action"] for c in sent]
    assert "detect_webmcp" in actions
    assert "list_routes" in actions
    replay = next(c for c in sent if c["action"] == "replay_route")
    assert replay["params"].get("url") == "https://docs.google.com/api/docs"
    # the API response was fed back to the model on a later turn
    all_msgs = json.dumps([c["messages"] for c in primary.calls])
    assert "HTTP 200" in all_msgs


def test_skill_is_recorded_then_replayed_with_zero_llm_calls(monkeypatch):
    # Run 1: full LLM agent completes a click task -> records a skill. Run 2: same task/host -> replays via the no-LLM fast path (the speed win).
    import backend.apps.agents.browser.browser_skills as SK
    SK.clear()
    BH.BROWSER_HISTORY.clear(); BH.DOMAIN_NOTES.clear()
    primary = FakeLLM([
        Resp([p_rp("click submit"), p_tu("BrowserListInteractives")]),
        Resp([p_rp("click it"), p_tu("BrowserClickIndex", index=1)]),
        Resp([Blk("text", "Done, clicked Search.")], stop_reason="end_turn"),
    ])
    aux = FakeAux()
    sent = p_install(monkeypatch, primary, aux)

    # Run 1 (learns). initial_url gives the host for record+replay keying.
    r1 = asyncio.run(BA.run_browser_agent(
        task="click the Search button", browser_id="b1", model="sonnet", initial_url=DOC_URL,
    ))
    assert not r1.get("replayed")
    assert SK.find_skill("docs.google.com", "click the Search button") is not None
    calls_after_run1 = len(primary.calls)
    assert calls_after_run1 > 0  # run 1 used the LLM

    # Run 2 (replays). Must NOT call the LLM at all, and must use click_by_name.
    sent.clear()
    r2 = asyncio.run(BA.run_browser_agent(
        task="Please click the Search button", browser_id="b1", model="sonnet", initial_url=DOC_URL,
    ))
    assert r2.get("replayed") is True
    assert len(primary.calls) == calls_after_run1, "run 2 must make ZERO LLM calls"
    assert any(c["action"] == "click_by_name" for c in sent), "replay should re-resolve by name"


def test_replay_falls_back_to_full_agent_when_a_step_fails(monkeypatch):
    # If the page changed and a replay step errors, we must abort replay and run the full LLM agent instead (never ghost-succeed on a stale skill).
    import backend.apps.agents.browser.browser_skills as SK
    SK.clear()
    BH.BROWSER_HISTORY.clear()
    # Pre-seed a skill whose click target no longer exists on the page.
    SK.record_skill("docs.google.com", "click the Save button", [
        {"tool": "BrowserClickIndex", "input": {"index": 1}, "ok": True,
         "clicked_role": "button", "clicked_name": "Save"},
    ])
    primary = FakeLLM([Resp([Blk("text", "handled by full agent")], stop_reason="end_turn")])
    aux = FakeAux()
    sent = p_install(monkeypatch, primary, aux)
    # make click_by_name FAIL (target gone) so replay must fall back
    orig = BA.ws_manager.send_browser_command
    async def p_fail_cbn(request_id, action, browser_id, params, tab_id=""):
        if action == "click_by_name":
            sent.append({"action": action, "params": params})
            return {"error": 'No element matching name="Save" on this page.'}
        return await orig(request_id, action, browser_id, params, tab_id)
    monkeypatch.setattr(BA.ws_manager, "send_browser_command", p_fail_cbn, raising=False)

    r = asyncio.run(BA.run_browser_agent(
        task="click the Save button", browser_id="b1", model="sonnet", initial_url=DOC_URL,
    ))
    assert not r.get("replayed"), "must NOT report a replayed success when a step failed"
    assert any(c["action"] == "click_by_name" for c in sent), "replay was attempted"
    assert len(primary.calls) > 0, "fell back to the full LLM agent"


def test_deferred_replay_fires_after_navigating_to_the_right_host(monkeypatch):
    # The #30 fix: the orchestrator opens a fresh card on the WRONG host (google), so the dispatch-time replay check misses. Once the agent navigates to the host that DOES have a skill, and nothing has dirtied the page yet, the deferred re-check must switch to replay instead of grinding the LLM loop.
    import backend.apps.agents.browser.browser_skills as SK
    SK.clear()
    BH.BROWSER_HISTORY.clear()
    SK.record_skill("docs.google.com", "click the Search button", [
        {"tool": "BrowserClickIndex", "input": {}, "ok": True,
         "clicked_role": "button", "clicked_name": "Search"},
    ])
    # turn 0 navigates to the doc; the re-check should preempt everything after.
    primary = FakeLLM([
        Resp([p_rp("go to the doc"), p_tu("BrowserNavigate", url=DOC_URL)]),
        Resp([p_rp("now click"), p_tu("BrowserClick", selector=".submit")]),
        Resp([Blk("text", "done")], stop_reason="end_turn"),
    ])
    sent = p_install(monkeypatch, primary, FakeAux())
    GOOGLE = "https://www.google.com/"
    orig = BA.ws_manager.send_browser_command

    async def p_cmd(request_id, action, browser_id, params, tab_id=""):
        # perception + reads report GOOGLE (so the DISPATCH replay misses there), navigation + clicks report the doc host (so the re-check matches)
        if action in ("list_interactives", "get_text"):
            return {"text": "stuff", "url": GOOGLE}
        return await orig(request_id, action, browser_id, params, tab_id)
    monkeypatch.setattr(BA.ws_manager, "send_browser_command", p_cmd, raising=False)

    # NO initial_url -> dispatch perceives google -> dispatch replay misses.
    r = asyncio.run(BA.run_browser_agent(
        task="Please click the Search button", browser_id="b1", model="sonnet",
    ))
    assert r.get("replayed") is True, "deferred re-check must replay after the navigation"
    assert any(c["action"] == "click_by_name" for c in sent), "replay re-resolved by name"
    assert len(primary.calls) == 1, "only the navigate turn ran; the re-check preempted the rest"
    # and the deferred replay still promotes the skill through the trust gate
    assert SK.find_skill("docs.google.com", "click the Search button")["state"] == SK.TRUSTED


def test_deferred_replay_does_not_fire_after_the_page_was_dirtied(monkeypatch):
    # Safety guard: if the agent already typed/clicked before reaching the right host, replaying from here is NOT equivalent to a clean dispatch (the page state is dirty), so the re-check must stay disabled and the LLM finishes.
    import backend.apps.agents.browser.browser_skills as SK
    SK.clear()
    BH.BROWSER_HISTORY.clear()
    SK.record_skill("docs.google.com", "click the Search button", [
        {"tool": "BrowserClickIndex", "input": {}, "ok": True,
         "clicked_role": "button", "clicked_name": "Search"},
    ])
    # turn 0 TYPES (dirties the page), THEN turn 1 navigates to the doc host.
    primary = FakeLLM([
        Resp([p_rp("type first"), p_tu("BrowserType", selector="#x", text="hi")]),
        Resp([p_rp("now go"), p_tu("BrowserNavigate", url=DOC_URL)]),
        Resp([Blk("text", "All done.")], stop_reason="end_turn"),
    ])
    sent = p_install(monkeypatch, primary, FakeAux())
    GOOGLE = "https://www.google.com/"
    orig = BA.ws_manager.send_browser_command

    async def p_cmd(request_id, action, browser_id, params, tab_id=""):
        if action in ("list_interactives", "get_text"):
            return {"text": "stuff", "url": GOOGLE}
        return await orig(request_id, action, browser_id, params, tab_id)
    monkeypatch.setattr(BA.ws_manager, "send_browser_command", p_cmd, raising=False)

    r = asyncio.run(BA.run_browser_agent(
        task="Please click the Search button", browser_id="b1", model="sonnet",
    ))
    # a dirtied page must NOT trigger the deferred replay; the LLM ran to the end
    assert not r.get("replayed"), "must not replay from a dirtied page state"
    assert not any(c["action"] == "click_by_name" for c in sent)
    assert len(primary.calls) >= 3, "the LLM loop finished normally"


def test_replay_resolves_host_from_live_page_when_no_initial_url(monkeypatch):
    # The real-flow fix: the parent often delegates to an EXISTING browser card with no initial_url (and the backend doesn't track where that card navigated). The agent must perceive the live page, learn its host, and STILL replay a previously-learned skill. Without this, replay was dead in the real orchestrated flow (records skills it can never look up again).
    import backend.apps.agents.browser.browser_skills as SK
    SK.clear()
    BH.BROWSER_HISTORY.clear()
    # a skill exists for the host the live page will report (DOC_URL -> docs.google.com)
    SK.record_skill("docs.google.com", "click the Search button", [
        {"tool": "BrowserClickIndex", "input": {}, "ok": True,
         "clicked_role": "button", "clicked_name": "Search"},
    ])
    primary = FakeLLM([Resp([Blk("text", "should not be needed")], stop_reason="end_turn")])
    aux = FakeAux()
    sent = p_install(monkeypatch, primary, aux)
    # NOTE: no initial_url passed; the fake browser reports url=DOC_URL via perception
    r = asyncio.run(BA.run_browser_agent(
        task="Please click the Search button", browser_id="b1", model="sonnet",
    ))
    assert r.get("replayed") is True, "must replay via host learned from the live page"
    assert len(primary.calls) == 0, "replay must make ZERO LLM calls"
    assert any(c["action"] == "click_by_name" for c in sent)


def test_skill_keys_on_parent_user_message_so_reformulations_share_a_skill(monkeypatch):
    # The measured real-flow blocker: the orchestrator reformulates the same user request differently each run ("click the search box" vs "find the search box"), so exact-key replay never hits. Keying on the parent's STABLE user message instead lets two different reformulations share one skill and replay.
    import backend.apps.agents.browser.browser_skills as SK
    import backend.apps.agents.agent_manager as am_mod
    SK.clear()
    BH.BROWSER_HISTORY.clear()

    class p_Msg:
        def __init__(self, role, content):
            self.role = role; self.content = content

    class p_Parent:
        messages = [p_Msg("user", 'search Wikipedia for "Ada Lovelace"')]
    monkeypatch.setattr(am_mod.agent_manager, "get_session", lambda sid: p_Parent(), raising=False)

    # Run 1: ONE reformulation of the request -> learns a skill keyed on the parent's user message (not this delegated wording).
    primary1 = FakeLLM([
        Resp([p_rp("click submit"), p_tu("BrowserListInteractives")]),
        Resp([p_rp("click it"), p_tu("BrowserClickIndex", index=1)]),
        Resp([Blk("text", "Done.")], stop_reason="end_turn"),
    ])
    p_install(monkeypatch, primary1, FakeAux())
    asyncio.run(BA.run_browser_agent(
        task="Go to wikipedia, click the search box, type Ada Lovelace, then submit",
        browser_id="b1", model="sonnet", initial_url=DOC_URL, parent_session_id="p1",
    ))
    assert SK.find_skill("docs.google.com", 'search Wikipedia for "Ada Lovelace"') is not None, \
        "skill must be keyed on the stable parent message, not the delegated reformulation"

    # Run 2: a DIFFERENT reformulation, same parent intent -> must REPLAY (the exact thing that failed live, now fixed).
    primary2 = FakeLLM([Resp([Blk("text", "should not be needed")], stop_reason="end_turn")])
    sent = p_install(monkeypatch, primary2, FakeAux())
    r = asyncio.run(BA.run_browser_agent(
        task="Navigate to wikipedia, find the search field, and submit Ada Lovelace",
        browser_id="b1", model="sonnet", initial_url=DOC_URL, parent_session_id="p1",
    ))
    assert r.get("replayed") is True, "different reformulation of the same request must replay"
    assert len(primary2.calls) == 0, "replay must make zero LLM calls"


def test_skill_key_falls_back_to_delegated_task_on_multi_quote_message(monkeypatch):
    # Guard against same-host collisions: a user message with several quoted values could spawn several same-host sub-tasks that must NOT share one key.
    import backend.apps.agents.browser.browser_skills as SK
    import backend.apps.agents.agent_manager as am_mod
    SK.clear()
    BH.BROWSER_HISTORY.clear()

    class p_Msg:
        def __init__(self, role, content):
            self.role = role; self.content = content

    class p_Parent:
        messages = [p_Msg("user", 'search Wikipedia for "Ada Lovelace" and also "Grace Hopper"')]
    monkeypatch.setattr(am_mod.agent_manager, "get_session", lambda sid: p_Parent(), raising=False)

    primary = FakeLLM([
        Resp([p_rp("go"), p_tu("BrowserClickIndex", index=1)]),
        Resp([Blk("text", "Done.")], stop_reason="end_turn"),
    ])
    p_install(monkeypatch, primary, FakeAux())
    asyncio.run(BA.run_browser_agent(
        task="search wikipedia for Ada Lovelace", browser_id="b1", model="sonnet",
        initial_url=DOC_URL, parent_session_id="p1",
    ))
    # the multi-quote message is NOT used as the key; the delegated task is
    assert SK.find_skill("docs.google.com", 'search Wikipedia for "Ada Lovelace" and also "Grace Hopper"') is None
    assert SK.find_skill("docs.google.com", "search wikipedia for Ada Lovelace") is not None


def test_replay_success_promotes_skill_to_trusted_through_the_loop(monkeypatch):
    # The verify gate, end to end: run 1 learns a PROBATION skill; run 2 replays it successfully, which must PROMOTE it to trusted (proven by a real replay).
    import backend.apps.agents.browser.browser_skills as SK
    SK.clear()
    BH.BROWSER_HISTORY.clear(); BH.DOMAIN_NOTES.clear()
    primary = FakeLLM([
        Resp([p_rp("click submit"), p_tu("BrowserListInteractives")]),
        Resp([p_rp("click it"), p_tu("BrowserClickIndex", index=1)]),
        Resp([Blk("text", "Done.")], stop_reason="end_turn"),
    ])
    aux = FakeAux()
    p_install(monkeypatch, primary, aux)
    asyncio.run(BA.run_browser_agent(
        task="click the Search button", browser_id="b1", model="sonnet", initial_url=DOC_URL,
    ))
    assert SK.find_skill("docs.google.com", "click the Search button")["state"] == SK.PROBATION
    r2 = asyncio.run(BA.run_browser_agent(
        task="click the Search button", browser_id="b1", model="sonnet", initial_url=DOC_URL,
    ))
    assert r2.get("replayed") is True
    assert SK.find_skill("docs.google.com", "click the Search button")["state"] == SK.TRUSTED


def test_skill_with_send_step_never_replays_silently(monkeypatch):
    # The audit finding: replay bypasses act-and-confirm and the per-tool gate, so a recorded Send/Submit must NOT auto-replay; the live agent (which confirms before anything outward) runs instead, and trust is untouched.
    import backend.apps.agents.browser.browser_skills as SK
    SK.clear()
    BH.BROWSER_HISTORY.clear()
    SK.record_skill("docs.google.com", "message tyler saying hi", [
        {"tool": "BrowserClickIndex", "input": {}, "ok": True,
         "clicked_role": "button", "clicked_name": "Send"},
    ])
    primary = FakeLLM([Resp([Blk("text", "handled live with confirmation")], stop_reason="end_turn")])
    sent = p_install(monkeypatch, primary, FakeAux())
    r = asyncio.run(BA.run_browser_agent(
        task="message tyler saying hi", browser_id="b1", model="sonnet", initial_url=DOC_URL,
    ))
    assert not r.get("replayed"), "a send-step skill must never auto-replay"
    assert not any(c["action"] == "click_by_name" for c in sent), "the recorded Send was not re-fired"
    assert len(primary.calls) > 0, "the live agent ran instead"
    assert SK.find_skill("docs.google.com", "message tyler saying hi")["state"] == SK.PROBATION, \
        "skipping replay is not a replay failure; trust stays untouched"


def test_unproven_skill_that_fails_is_quarantined_and_never_retried(monkeypatch):
    # The anti-ghost guard, end to end: an unproven skill that fails a replay must be quarantined so the NEXT run does not even attempt the (known-bad) replay, it goes straight to the pure-LLM baseline. A silent re-fail would be a ghost.
    import backend.apps.agents.browser.browser_skills as SK
    SK.clear()
    BH.BROWSER_HISTORY.clear()
    SK.record_skill("docs.google.com", "click the Save button", [
        {"tool": "BrowserClickIndex", "input": {"index": 1}, "ok": True,
         "clicked_role": "button", "clicked_name": "Save"},
    ])  # probation, unproven
    primary = FakeLLM([Resp([Blk("text", "full agent handled it")], stop_reason="end_turn")])
    aux = FakeAux()
    sent = p_install(monkeypatch, primary, aux)
    orig = BA.ws_manager.send_browser_command

    async def p_fail_cbn(request_id, action, browser_id, params, tab_id=""):
        if action == "click_by_name":
            sent.append({"action": action, "params": params})
            return {"error": 'No element matching name="Save" on this page.'}
        return await orig(request_id, action, browser_id, params, tab_id)
    monkeypatch.setattr(BA.ws_manager, "send_browser_command", p_fail_cbn, raising=False)

    # Run 1: replay is attempted, the step fails -> skill is quarantined.
    asyncio.run(BA.run_browser_agent(
        task="click the Save button", browser_id="b1", model="sonnet", initial_url=DOC_URL,
    ))
    assert any(c["action"] == "click_by_name" for c in sent), "run 1 DID attempt the replay"
    assert SK.list_skills("docs.google.com")[0]["state"] == SK.QUARANTINE

    # Run 2: the quarantined skill must NOT be replayed again.
    sent.clear()
    r2 = asyncio.run(BA.run_browser_agent(
        task="click the Save button", browser_id="b1", model="sonnet", initial_url=DOC_URL,
    ))
    assert not r2.get("replayed")
    assert not any(c["action"] == "click_by_name" for c in sent), \
        "a quarantined skill must never be replayed again (would be a ghost re-fail)"


def test_informational_run_records_no_skill_to_avoid_thin_ghost(monkeypatch):
    # The 'find me 10 X' guard: a run that did real productive actions AND succeeded, but whose deliverable is gathered/judged content (a list), must NOT record a replayable skill, because replay would redo the clicks and falsely claim the whole task done without regenerating the judged list.
    import backend.apps.agents.browser.browser_skills as SK
    SK.clear()
    BH.BROWSER_HISTORY.clear()
    ten = "\n".join(f"{i}. Engineer {i}, very cracked, at Startup{i}" for i in range(1, 11))
    primary = FakeLLM([
        Resp([p_rp("search"), p_tu("BrowserClickIndex", index=1)]),  # a real productive action
        Resp([Blk("text", ten)], stop_reason="end_turn"),          # ...but the answer is a gathered list
    ])
    p_install(monkeypatch, primary, FakeAux())
    r = asyncio.run(BA.run_browser_agent(
        task="find me 10 cracked design engineers", browser_id="b1", model="sonnet", initial_url=DOC_URL,
    ))
    # the run itself completes honestly (it did real work + returned content)...
    assert not r.get("error")
    # ...but NO skill is recorded, so a later run can't ghost-replay a thin shortcut
    assert SK.find_skill("docs.google.com", "find me 10 cracked design engineers") is None


def test_read_answered_from_frontloaded_perception_is_not_a_ghost(monkeypatch):
    # REGRESSION: front-loading reads perception into turn 1; if the agent answers a read task straight from that (zero further tools), the honesty gate must NOT flag it as 'declared done without taking a single action'. The front- loaded reads are real and seed action_log. (This bug caused retry loops.)
    BH.BROWSER_HISTORY.clear()
    primary = FakeLLM([
        # the model answers immediately from the front-loaded page text, no tools
        Resp([Blk("text", "The first sentence is: Alan Turing was a mathematician.")], stop_reason="end_turn"),
    ])
    captured = {}
    p_install(monkeypatch, primary, FakeAux())
    orig = BA.ws_manager.send_to_session

    async def p_cap(session_id, event, payload):
        if event == "agent:status":
            captured["status"] = payload.get("status")
        return await orig(session_id, event, payload)
    monkeypatch.setattr(BA.ws_manager, "send_to_session", p_cap, raising=False)

    r = asyncio.run(BA.run_browser_agent(
        task="read me the first sentence", browser_id="b1", model="sonnet", initial_url=DOC_URL,
    ))
    # the fake get_text returns content during front-load -> honest completion
    assert captured.get("status") == "completed", "answering from front-loaded perception is honest, not a ghost"
    assert not r.get("error")


def test_ghost_completion_is_reported_as_error_not_completed(monkeypatch):
    # The measured ghost, end to end: the model does a bunch of failing clicks then declares done. The honesty gate must report 'error' (not 'completed') and must NOT record a skill from a run that accomplished nothing.
    import backend.apps.agents.browser.browser_skills as SK
    SK.clear()
    BH.BROWSER_HISTORY.clear()
    primary = FakeLLM([
        Resp([p_rp("click submit"), p_tu("BrowserClick", selector=".s1")]),
        Resp([p_rp("retry"), p_tu("BrowserClick", selector=".s2")]),
        Resp([Blk("text", "All done, submitted successfully!")], stop_reason="end_turn"),
    ])
    aux = FakeAux()
    sent = p_install(monkeypatch, primary, aux)
    # every click errors (the fake returns an error for action 'click')
    captured = {}
    orig_send = BA.ws_manager.send_to_session

    async def p_cap(session_id, event, payload):
        if event == "agent:status":
            captured["status"] = payload.get("status")
        return await orig_send(session_id, event, payload)
    monkeypatch.setattr(BA.ws_manager, "send_to_session", p_cap, raising=False)

    r = asyncio.run(BA.run_browser_agent(
        task="Submit the form", browser_id="b1", model="sonnet", initial_url=DOC_URL,
    ))
    # the model claimed success, but every action errored -> honest 'error'
    assert captured.get("status") == "error", "a did-nothing run must not report completed"
    assert "not able to complete" in r["summary"].lower()
    assert r.get("error"), "the failure must be surfaced to the parent"
    # and nothing was learned from the fake success
    assert SK.find_skill("docs.google.com", "Submit the form") is None


def test_dead_browser_card_aborts_fast_without_spinning(monkeypatch):
    # The measured waste: a sub-agent dispatched to a released card retried the dead webview for many turns. Now a gone card must abort fast (a couple of turns, not the whole budget) and report the precise reason.
    import backend.apps.agents.browser.browser_skills as SK
    SK.clear()
    BH.BROWSER_HISTORY.clear()
    # the model would happily keep clicking for 8 turns if we let it
    primary = FakeLLM(
        [Resp([p_rp("click"), p_tu("BrowserClick", selector=f".s{i}")]) for i in range(8)]
        + [Resp([Blk("text", "done")], stop_reason="end_turn")]
    )
    aux = FakeAux()
    p_install(monkeypatch, primary, aux)

    async def p_card_gone(request_id, action, browser_id, params, tab_id=""):
        return {"error": f"Browser card '{browser_id}' not found or not an Electron webview"}
    monkeypatch.setattr(BA.ws_manager, "send_browser_command", p_card_gone, raising=False)
    captured = {}
    orig = BA.ws_manager.send_to_session

    async def p_cap(session_id, event, payload):
        if event == "agent:status":
            captured["status"] = payload.get("status")
        return await orig(session_id, event, payload)
    monkeypatch.setattr(BA.ws_manager, "send_to_session", p_cap, raising=False)

    r = asyncio.run(BA.run_browser_agent(
        task="Click submit", browser_id="b1", model="sonnet", initial_url=DOC_URL,
    ))
    assert len(primary.calls) <= 3, "a dead card must fail fast, not spin the whole budget"
    assert captured.get("status") == "error"
    assert "unresponsive" in r["summary"].lower()


def test_hung_browser_card_aborts_fast_not_a_20_minute_loop(monkeypatch):
    # THE regression from the user's 20-min LinkedIn freeze: a HUNG tab returns "Browser command timed out" on every command (not "card not found"), so the gone-detector never tripped and the agent spun for minutes. Now a hung card feeds the same fast-fail streak and aborts in a couple of turns.
    import backend.apps.agents.browser.browser_skills as SK
    SK.clear()
    BH.BROWSER_HISTORY.clear()
    primary = FakeLLM(
        [Resp([p_rp("read"), p_tu("BrowserGetText")]) for _ in range(8)]
        + [Resp([Blk("text", "done")], stop_reason="end_turn")]
    )
    p_install(monkeypatch, primary, FakeAux())

    async def p_hung(request_id, action, browser_id, params, tab_id=""):
        return {"error": "Browser command timed out"}  # what a wedged tab returns
    monkeypatch.setattr(BA.ws_manager, "send_browser_command", p_hung, raising=False)
    captured = {}
    orig = BA.ws_manager.send_to_session

    async def p_cap(session_id, event, payload):
        if event == "agent:status":
            captured["status"] = payload.get("status")
        return await orig(session_id, event, payload)
    monkeypatch.setattr(BA.ws_manager, "send_to_session", p_cap, raising=False)

    r = asyncio.run(BA.run_browser_agent(
        task="Read the page", browser_id="b1", model="sonnet", initial_url=DOC_URL,
    ))
    assert len(primary.calls) <= 3, "a hung card must abort fast, not spin for 20 minutes"
    assert captured.get("status") == "error"
    assert "unresponsive" in r["summary"].lower()


def test_perception_is_frontloaded_into_first_turn(monkeypatch):
    # With a known start URL, the agent should prefetch the element list + page text and put them in the FIRST user message, so the model can act on turn 1 instead of spending early turns orienting.
    BH.BROWSER_HISTORY.clear(); BH.DOMAIN_NOTES.clear()
    primary = FakeLLM([Resp([Blk("text", "done")], stop_reason="end_turn")])
    aux = FakeAux()
    p_install(monkeypatch, primary, aux)
    asyncio.run(BA.run_browser_agent(
        task="click submit", browser_id="bp", model="sonnet", initial_url=DOC_URL,
    ))
    first_user = primary.calls[0]["messages"][0]["content"]
    text = first_user if isinstance(first_user, str) else json.dumps(first_user)
    # the fake list_interactives returns a "[1]<button ...>" listing
    assert "Interactive elements already on the page" in text
    assert "act directly" in text


def test_prompt_caching_markers_present(monkeypatch):
    # The fixed system+tools prefix must carry cache_control so it's cached across turns (the first-run speed/cost win). Without the marker the ~4k-token prefix is reprocessed every turn.
    BH.BROWSER_HISTORY.clear(); BH.DOMAIN_NOTES.clear()
    primary = FakeLLM([Resp([Blk("text", "done")], stop_reason="end_turn")])
    aux = FakeAux()
    p_install(monkeypatch, primary, aux)
    asyncio.run(BA.run_browser_agent(task="hi", browser_id="bz", model="sonnet"))
    call = primary.calls[0]
    sys = call["system"]
    assert isinstance(sys, list) and sys[-1]["cache_control"]["type"] == "ephemeral"
    tools = call["tools"]
    assert tools[-1].get("cache_control", {}).get("type") == "ephemeral"
    # exactly one cache marker on the tools array (Anthropic allows <=4; we use 1)
    assert sum(1 for t in tools if t.get("cache_control")) == 1


def test_agent_can_list_and_deprecate_its_own_skills(monkeypatch):
    # The agent calls BrowserListSkills + BrowserDeprecateSkill inline (backend- handled, never sent to the webview), giving it agency over its own memory.
    import backend.apps.agents.browser.browser_skills as SK
    SK.clear()
    BH.BROWSER_HISTORY.clear()
    # pre-seed a skill on this host
    SK.record_skill("docs.google.com", "share the doc now", [
        {"tool": "BrowserClickIndex", "input": {}, "ok": True, "clicked_role": "button", "clicked_name": "Share"},
    ])
    primary = FakeLLM([
        Resp([p_rp("check what i know here"), p_tu("BrowserListSkills")]),
        Resp([p_rp("that one is stale, drop it"), p_tu("BrowserDeprecateSkill", task="share the doc now")]),
        Resp([Blk("text", "Pruned the stale shortcut.")], stop_reason="end_turn"),
    ])
    aux = FakeAux()
    sent = p_install(monkeypatch, primary, aux)
    asyncio.run(BA.run_browser_agent(
        task="manage my shortcuts", browser_id="bm", model="sonnet", initial_url=DOC_URL,
    ))
    # neither inline tool is sent to the webview executor
    assert not any(c["action"] in ("list_skills", "deprecate_skill") for c in sent)
    # the LLM saw the skill listing, then the deprecate confirmation
    all_msgs = json.dumps([c["messages"] for c in primary.calls])
    assert "Learned shortcuts for docs.google.com" in all_msgs
    assert "Removed the stale shortcut" in all_msgs
    # and the skill is actually gone
    assert SK.find_skill("docs.google.com", "share the doc now") is None


def test_playbook_distills_on_success_survives_restart_and_seeds_next_run(monkeypatch):
    # The tier-2 memory, end to end: a substantive judgment run distills a durable strategy playbook (one aux call), it persists across a restart, and the NEXT run on the same host gets it seeded into the system prompt, so the model skips re-discovery. This is what makes LinkedIn-style tasks wiser over time.
    import backend.apps.agents.browser.browser_playbook as PB
    import backend.apps.agents.browser.browser_skills as SK
    import json as p_json
    SK.clear(); PB.clear(wipe_disk=True)
    BH.BROWSER_HISTORY.clear()

    # aux returns a strategy playbook as JSON (the distill+reconcile reply)
    class PBAux:
        def __init__(self):
            self.calls = 0
            self.messages = self
        async def create(self, **kw):
            self.calls += 1
            txt = p_json.dumps({"playbook": [
                "generic 'design engineer' returns hardware engineers",
                "search Vercel/Linear + React to surface real design engineers",
            ]})
            return Resp([Blk("text", txt)], stop_reason="end_turn")

    # Run 1: a 4+ turn judgment task that completes honestly with a real action.
    primary1 = FakeLLM([
        Resp([p_rp("orient"), p_tu("BrowserListInteractives")]),
        Resp([p_rp("search"), p_tu("BrowserNavigate", url=DOC_URL)]),
        Resp([p_rp("read"), p_tu("BrowserGetText")]),
        Resp([p_rp("act"), p_tu("BrowserClickIndex", index=1)]),
        Resp([Blk("text", "Done. Found the people; the reliable method was company+React.")], stop_reason="end_turn"),
    ])
    pbaux = PBAux()
    p_install(monkeypatch, primary1, pbaux)
    p_run_settled(
        task="find design engineers", browser_id="b1", model="sonnet", initial_url=DOC_URL,
    )
    assert pbaux.calls >= 1, "a substantive success must trigger the distill aux call"
    assert PB.get_playbook("docs.google.com"), "playbook recorded for the host"

    # Restart: drop in-memory, keep disk.
    PB.clear(wipe_disk=False)
    assert not PB.CACHE

    # Run 2: fresh task, same host -> playbook must be seeded into the system prompt.
    primary2 = FakeLLM([Resp([Blk("text", "done")], stop_reason="end_turn")])
    p_install(monkeypatch, primary2, FakeAux())
    asyncio.run(BA.run_browser_agent(
        task="find more engineers", browser_id="b2", model="sonnet", initial_url=DOC_URL,
    ))
    system = primary2.calls[0]["system"]
    system_text = system if isinstance(system, str) else " ".join(b.get("text", "") for b in system)
    assert "What you learned about docs.google.com" in system_text
    assert "Vercel/Linear + React" in system_text


def test_ambient_memory_signals_fire_calmly(monkeypatch):
    # Perceived value, zero clicks: the user should SEE the agent (a) pick up what it learned when strategy is seeded, and (b) note new learning at the end, both as calm one-liners in the existing stream, only when real.
    import backend.apps.agents.browser.browser_playbook as PB
    import backend.apps.agents.browser.browser_skills as SK
    import json as p_json
    SK.clear(); PB.clear(wipe_disk=True)
    BH.BROWSER_HISTORY.clear()

    class PBAux:
        def __init__(self): self.messages = self
        async def create(self, **kw):
            return Resp([Blk("text", p_json.dumps({"playbook": ["search company+React, not generic"]}))],
                        stop_reason="end_turn")
    msgs = []
    orig = BA.ws_manager.send_to_session

    async def p_cap(session_id, event, payload):
        if event == "agent:message":
            c = payload.get("message", {}).get("content")
            msgs.append(c if isinstance(c, str) else (c or {}).get("text", ""))
        return await orig(session_id, event, payload)
    monkeypatch.setattr(BA.ws_manager, "send_to_session", p_cap, raising=False)

    def p_run():
        return FakeLLM([
            Resp([p_rp("orient"), p_tu("BrowserListInteractives")]),
            Resp([p_rp("go"), p_tu("BrowserNavigate", url=DOC_URL)]),
            Resp([p_rp("read"), p_tu("BrowserGetText")]),
            Resp([p_rp("act"), p_tu("BrowserClickIndex", index=1)]),
            Resp([Blk("text", "Done, found them.")], stop_reason="end_turn"),
        ])

    # Run 1: nothing learned yet -> NO recall line, but it learns -> closing line.
    p_install(monkeypatch, p_run(), PBAux())
    monkeypatch.setattr(BA.ws_manager, "send_to_session", p_cap, raising=False)
    p_run_settled(task="find engineers", browser_id="b1", model="sonnet", initial_url=DOC_URL)
    joined1 = " ".join(msgs)
    assert "Picking up what I learned" not in joined1, "no recall on the first-ever visit"
    assert "so I'm faster here next time" in joined1, "closing 'learned' line after first success"

    # Run 2: now there's a playbook -> recall line fires.
    msgs.clear()
    p_install(monkeypatch, p_run(), PBAux())
    monkeypatch.setattr(BA.ws_manager, "send_to_session", p_cap, raising=False)
    asyncio.run(BA.run_browser_agent(task="find more", browser_id="b2", model="sonnet", initial_url=DOC_URL))
    assert any("Picking up what I learned about docs.google.com" in m for m in msgs), "recall line on a return visit"


def test_playbook_not_learned_from_a_ghost_completion(monkeypatch):
    # Fail-safe: a dishonest 'completion' (all actions errored) must NOT distill a playbook, garbage strategy from a failed run would mislead future runs.
    import backend.apps.agents.browser.browser_playbook as PB
    import backend.apps.agents.browser.browser_skills as SK
    SK.clear(); PB.clear(wipe_disk=True)
    BH.BROWSER_HISTORY.clear()

    class CountingAux:
        def __init__(self):
            self.calls = 0
            self.messages = self
        async def create(self, **kw):
            self.calls += 1
            return Resp([Blk("text", "Try something else.")], stop_reason="end_turn")

    # every click errors -> the honesty gate marks the run an error (ghost)
    primary = FakeLLM([
        Resp([p_rp("go"), p_tu("BrowserClick", selector=".s1")]),
        Resp([p_rp("go"), p_tu("BrowserClick", selector=".s2")]),
        Resp([p_rp("go"), p_tu("BrowserClick", selector=".s3")]),
        Resp([p_rp("go"), p_tu("BrowserClick", selector=".s4")]),
        Resp([Blk("text", "All set!")], stop_reason="end_turn"),
    ])
    aux = CountingAux()
    p_install(monkeypatch, primary, aux)
    asyncio.run(BA.run_browser_agent(
        task="do the thing", browser_id="b1", model="sonnet", initial_url=DOC_URL,
    ))
    # the only aux call allowed here is the stuck-adjudication; the playbook distill must NOT have stored anything for a dishonest run
    assert PB.get_playbook("docs.google.com") == []


def test_batch_replay_runs_a_read_loop_for_all_values(monkeypatch):
    # The win: do one item the slow way, then BrowserRepeatFlow runs the same read flow for the rest at machine speed, one tool turn, no screenshots.
    BH.BROWSER_HISTORY.clear()
    steps = [{"action": "navigate", "url": "https://docs.google.com/in/{{value}}"},
             {"action": "evaluate", "expression": "read('{{value}}')"}]
    primary = FakeLLM([
        Resp([p_rp("batch the rest"), p_tu("BrowserRepeatFlow", steps=steps, values=["ada", "grace", "alan"])]),
        Resp([Blk("text", "Read all three.")], stop_reason="end_turn"),
    ])
    sent = p_install(monkeypatch, primary, FakeAux())

    async def p_data(request_id, action, browser_id, params, tab_id=""):
        sent.append({"action": action, "params": params})
        if action == "evaluate":
            # return value-specific data so we can prove the DATA comes back
            who = params["expression"].split("'")[1]
            return {"text": f"bio of {who}", "url": DOC_URL}
        if action == "navigate":
            return {"text": "Navigated", "url": params.get("url")}
        return {"text": "ok", "url": DOC_URL}
    monkeypatch.setattr(BA.ws_manager, "send_browser_command", p_data, raising=False)

    asyncio.run(BA.run_browser_agent(task="read three profiles", browser_id="b1", model="sonnet", initial_url=DOC_URL))
    navs = [c for c in sent if c["action"] == "navigate" and "/in/" in c["params"].get("url", "")]
    assert {c["params"]["url"].split("/in/")[1] for c in navs} == {"ada", "grace", "alan"}, "navigated each value"
    all_msgs = json.dumps([c["messages"] for c in primary.calls])
    assert "Read 3 of 3" in all_msgs
    # Change #1: the actual per-item DATA is handed back, not just a count
    assert "ada: bio of ada" in all_msgs and "grace: bio of grace" in all_msgs and "alan: bio of alan" in all_msgs


def test_batch_replay_is_ghost_proof_when_an_item_does_not_match(monkeypatch):
    # THE anti-ghost test: per-item pages vary. Value 'grace' errors mid-flow -> it must be reported as needs-manual, the others still succeed, and the tally is HONEST ('2 of 3'), never a silent 'did them all'.
    BH.BROWSER_HISTORY.clear()
    steps = [{"action": "navigate", "url": "https://docs.google.com/in/{{value}}"},
             {"action": "evaluate", "expression": "read('{{value}}')"}]
    primary = FakeLLM([
        Resp([p_rp("batch"), p_tu("BrowserRepeatFlow", steps=steps, values=["ada", "grace", "alan"])]),
        Resp([Blk("text", "Handled.")], stop_reason="end_turn"),
    ])
    sent = p_install(monkeypatch, primary, FakeAux())

    async def p_vary(request_id, action, browser_id, params, tab_id=""):
        sent.append({"action": action, "params": params})
        if action == "navigate" and "grace" in params.get("url", ""):
            return {"error": "Page not found for grace (different layout)"}
        if action == "navigate":
            return {"text": "Navigated", "url": params.get("url")}
        return {"text": "profile data", "url": DOC_URL}
    monkeypatch.setattr(BA.ws_manager, "send_browser_command", p_vary, raising=False)

    asyncio.run(BA.run_browser_agent(task="read three", browser_id="b1", model="sonnet", initial_url=DOC_URL))
    all_msgs = json.dumps([c["messages"] for c in primary.calls])
    assert "Read 2 of 3" in all_msgs, "honest tally, not a ghost 'all done'"
    assert "grace" in all_msgs, "the failed item is surfaced for manual handling"
    assert "Page not found for grace" in all_msgs, "the failure REASON is reported, not hidden"
    # grace errored at navigate -> its read must NOT have run; ada+alan did
    reads = {c["params"]["expression"] for c in sent if c["action"] == "evaluate"}
    assert "read('grace')" not in reads, "the failed item must NOT proceed (no ghost)"
    assert reads == {"read('ada')", "read('alan')"}, "exactly the matching items ran"


def test_batch_replay_refuses_a_send_loop_and_executes_nothing(monkeypatch):
    # The send gate: a flow that clicks 'Send message' must be REFUSED outright, nothing is clicked, so we can never auto-message N people.
    BH.BROWSER_HISTORY.clear()
    steps = [{"action": "navigate", "url": "https://docs.google.com/in/{{value}}"},
             {"action": "click", "role": "button", "name": "Message"},
             {"action": "type", "selector": "#msg", "text": "hi {{value}}"},
             {"action": "click", "role": "button", "name": "Send"}]
    primary = FakeLLM([
        Resp([p_rp("blast messages"), p_tu("BrowserRepeatFlow", steps=steps, values=["a", "b", "c"])]),
        Resp([Blk("text", "Okay, individually then.")], stop_reason="end_turn"),
    ])
    sent = p_install(monkeypatch, primary, FakeAux())
    asyncio.run(BA.run_browser_agent(task="message people", browser_id="b1", model="sonnet", initial_url=DOC_URL))
    all_msgs = json.dumps([c["messages"] for c in primary.calls])
    assert "Refused to auto-repeat" in all_msgs and "one at a time" in all_msgs
    # NOTHING from the loop ran: no navigate to a value, no clicks
    assert not any(c["action"] == "navigate" and "/in/" in c["params"].get("url", "") for c in sent)
    assert not any(c["action"] == "click_by_name" for c in sent)


def test_batch_replay_uses_the_fast_network_route_per_value(monkeypatch):
    # Folds in the audit finding: a read-loop can hit a captured API endpoint (replay_route) per value instead of clicking the UI, the fast tier.
    BH.BROWSER_HISTORY.clear()
    steps = [{"action": "replay_route", "url": "https://docs.google.com/api/p?u={{value}}"}]
    primary = FakeLLM([
        Resp([p_rp("fetch via api"), p_tu("BrowserRepeatFlow", steps=steps, values=["ada", "grace"])]),
        Resp([Blk("text", "Got both via API.")], stop_reason="end_turn"),
    ])
    sent = p_install(monkeypatch, primary, FakeAux())
    asyncio.run(BA.run_browser_agent(task="fetch two", browser_id="b1", model="sonnet", initial_url=DOC_URL))
    routes = [c["params"]["url"] for c in sent if c["action"] == "replay_route"]
    assert any("u=ada" in u for u in routes) and any("u=grace" in u for u in routes)


def test_captured_routes_are_surfaced_once_per_host(monkeypatch):
    # Drives the dead network tier: when a READ shows safe GET routes were captured (sampled on get_text, after the SPA's XHRs fired, not on navigate), the agent gets a ONE-TIME nudge per host toward BrowserReplayRoute, not on every read.
    BH.BROWSER_HISTORY.clear()
    primary = FakeLLM([
        Resp([p_rp("read 1"), p_tu("BrowserEvaluate", expression="document.title")]),
        Resp([p_rp("read 2"), p_tu("BrowserEvaluate", expression="document.title")]),
        Resp([Blk("text", "done")], stop_reason="end_turn"),
    ])
    sent = p_install(monkeypatch, primary, FakeAux())
    orig = BA.ws_manager.send_browser_command

    async def p_with_routes(request_id, action, browser_id, params, tab_id=""):
        if action == "evaluate":
            return {"text": "Reddit Programming", "url": DOC_URL, "routes_available": 4}
        return await orig(request_id, action, browser_id, params, tab_id)
    monkeypatch.setattr(BA.ws_manager, "send_browser_command", p_with_routes, raising=False)

    asyncio.run(BA.run_browser_agent(task="browse", browser_id="b1", model="sonnet", initial_url=DOC_URL))
    # messages are cumulative across calls, so count within ONE call's full conversation: the nudge must appear exactly once for docs.google.com (not per read)
    final_convo = json.dumps(primary.calls[-1]["messages"])
    assert final_convo.count("API endpoint(s) were captured") == 1


def test_browser_wait_routes_through_smart_wait_and_returns_early(monkeypatch):
    # BrowserWait must no longer be a blind sleep: it probes the page (evaluate) and returns as soon as it's settled, well under the requested cap.
    BH.BROWSER_HISTORY.clear()
    primary = FakeLLM([
        Resp([p_rp("let it settle"), p_tu("BrowserWait", milliseconds=8000)]),
        Resp([Blk("text", "Settled, moving on.")], stop_reason="end_turn"),
    ])
    sent = p_install(monkeypatch, primary, FakeAux())
    import time as p_t
    t0 = p_t.time()
    asyncio.run(BA.run_browser_agent(task="wait then act", browser_id="b1", model="sonnet", initial_url=DOC_URL))
    elapsed = p_t.time() - t0
    # it probed via evaluate (smart), not a blind 'wait' action...
    assert any(c["action"] == "evaluate" and "getEntriesByType" in str(c["params"].get("expression", "")) for c in sent)
    assert not any(c["action"] == "wait" for c in sent), "no blind wait dispatched"
    # ...and the whole run finished far faster than the 8s cap (it settled early)
    assert elapsed < 4.0, "smart wait returned early instead of sleeping the full cap"


def test_prior_domain_hint_is_seeded_into_system_prompt(monkeypatch):
    BH.BROWSER_HISTORY.clear(); BH.DOMAIN_NOTES.clear()
    BH.set_domain_note("google.com", "REMEMBERED: Share button is index 43; Tab into the dialog.")
    primary = FakeLLM([Resp([Blk("text", "done")], stop_reason="end_turn")])
    aux = FakeAux()
    p_install(monkeypatch, primary, aux)

    asyncio.run(BA.run_browser_agent(
        task="open the doc", browser_id="b2", model="sonnet", initial_url=DOC_URL,
    ))
    assert primary.calls, "LLM should have been called"
    # system is a cached content-block list (prompt caching); flatten its text
    system = primary.calls[0]["system"]
    system_text = system if isinstance(system, str) else " ".join(b.get("text", "") for b in system)
    assert "Notes from a previous visit" in system_text
    assert "REMEMBERED: Share button is index 43" in system_text
    # the cached system block carries the cache_control marker
    if isinstance(system, list):
        assert system[-1].get("cache_control", {}).get("type") == "ephemeral"
    assert len(aux.calls) == 0  # no exhaustion, no adjudication on a clean run


def test_find_reusable_card_reuses_own_then_orphan_never_user(monkeypatch):
    # Concurrent same-site webviews wedge each other, so a re-dispatch must reuse the parent's own (or an orphaned) spawned card instead of stacking another. User-created cards (no spawned_by) are never grabbed implicitly.
    import backend.apps.dashboards.dashboards as dash_mod
    import backend.apps.agents.agent_manager as am_mod

    class p_Card:
        def __init__(self, url, spawned_by):
            self.url = url
            self.spawned_by = spawned_by

    class p_Layout:
        browser_cards = {
            "b-user": p_Card("https://www.linkedin.com/feed/", None),
            "b-orphan": p_Card("https://www.linkedin.com/search/x", "dead-parent"),
            "b-own": p_Card("https://www.linkedin.com/in/y", "p1"),
            "b-hn": p_Card("https://news.ycombinator.com/", "p1"),
        }

    class p_Dash:
        layout = p_Layout()

    monkeypatch.setattr(dash_mod, "load", lambda did: p_Dash(), raising=True)

    class p_Done:
        status = "completed"
    monkeypatch.setattr(am_mod.agent_manager, "get_session", lambda sid: p_Done(), raising=False)

    target = "https://www.linkedin.com/search/results/people/?keywords=t"
    # the parent's own same-host card wins
    assert BA.find_reusable_card("d1", target, "p1") == "b-own"
    # a different parent skips p1's... unless that parent finished (orphan); first orphan wins
    assert BA.find_reusable_card("d1", target, "p2") == "b-orphan"
    # never a different host
    assert BA.find_reusable_card("d1", "https://example.com/", "p1") == ""
    # an actively-driven card is never grabbed
    BA.ACTIVE_AGENT_CARDS.update({"b-own", "b-orphan"})
    try:
        assert BA.find_reusable_card("d1", target, "p1") == ""
    finally:
        BA.ACTIVE_AGENT_CARDS.clear()
    # cards of a still-RUNNING other parent are off limits
    class p_Running:
        status = "running"
    monkeypatch.setattr(am_mod.agent_manager, "get_session", lambda sid: p_Running(), raising=False)
    assert BA.find_reusable_card("d1", target, "p2") == ""


def p_fake_settle(calls):
    async def fake_smart_wait(execute_fn, browser_id, tab_id, max_ms, **kw):
        calls.append(("settle", max_ms))
        return {"settled": True, "hung": False}
    return fake_smart_wait


def p_fake_exec(calls, list_text='3 interactive elements\n[1]<button "A">'):
    async def wait_exec(tool, params, bid, tid):
        calls.append((tool, dict(params)))
        return {"text": list_text}
    return wait_exec


def test_post_action_state_settles_then_attaches(monkeypatch):
    import asyncio
    from backend.apps.agents.browser import browser_agent as ba
    calls = []
    monkeypatch.setattr(ba.browser_wait, "smart_wait", p_fake_settle(calls))
    out = asyncio.run(ba.post_action_state(
        "BrowserClickIndex", {"index": 1}, {"text": "Clicked"},
        "b1", "", p_fake_exec(calls), "find tyler",
    ))
    assert ba.PAGE_STATE_MARKER in out and '[1]<button "A">' in out
    assert ("settle", 1200) in calls
    assert ("BrowserListInteractives", {"goal": "find tyler"}) in calls


def test_post_action_state_navigate_gets_longer_settle(monkeypatch):
    import asyncio
    from backend.apps.agents.browser import browser_agent as ba
    calls = []
    monkeypatch.setattr(ba.browser_wait, "smart_wait", p_fake_settle(calls))
    asyncio.run(ba.post_action_state(
        "BrowserNavigate", {"url": "https://x.com"}, {"text": "Navigated"},
        "b1", "", p_fake_exec(calls), "",
    ))
    assert ("settle", 2500) in calls


def test_post_action_state_expect_skips_double_settle(monkeypatch):
    import asyncio
    from backend.apps.agents.browser import browser_agent as ba
    calls = []
    monkeypatch.setattr(ba.browser_wait, "smart_wait", p_fake_settle(calls))
    out = asyncio.run(ba.post_action_state(
        "BrowserClickIndex", {"index": 2, "expect": "Sent"}, {"text": "Clicked"},
        "b1", "", p_fake_exec(calls), "",
    ))
    assert not any(c[0] == "settle" for c in calls)
    assert ba.PAGE_STATE_MARKER in out


def test_post_action_state_skips_errors_reads_and_batch_reads(monkeypatch):
    import asyncio
    from backend.apps.agents.browser import browser_agent as ba
    calls = []
    monkeypatch.setattr(ba.browser_wait, "smart_wait", p_fake_settle(calls))
    exec_fn = p_fake_exec(calls)
    assert asyncio.run(ba.post_action_state(
        "BrowserClickIndex", {"index": 1}, {"error": "nope"}, "b", "", exec_fn, "")) == ""
    assert asyncio.run(ba.post_action_state(
        "BrowserGetText", {}, {"text": "page text"}, "b", "", exec_fn, "")) == ""
    batch_in = {"actions": [{"type": "click_index", "params": {"index": 1}},
                            {"type": "list_interactives", "params": {}}]}
    assert asyncio.run(ba.post_action_state(
        "BrowserBatch", batch_in, {"text": "ran 2"}, "b", "", exec_fn, "")) == ""
    assert calls == []


def test_post_action_state_truncates_long_lists(monkeypatch):
    import asyncio
    from backend.apps.agents.browser import browser_agent as ba
    calls = []
    monkeypatch.setattr(ba.browser_wait, "smart_wait", p_fake_settle(calls))
    # cap is 60 (matches the frontend list cap); truncation only kicks in past that
    long_list = "\n".join(f'[{i}]<button "b{i}">' for i in range(80))
    out = asyncio.run(ba.post_action_state(
        "BrowserType", {"selector": "#q", "text": "hi"}, {"text": "Typed"},
        "b1", "", p_fake_exec(calls, long_list), "",
    ))
    assert "(+20 more rows" in out and '[59]<button "b59">' in out and '[60]' not in out


def test_post_action_state_hung_settle_attaches_nothing(monkeypatch):
    import asyncio
    from backend.apps.agents.browser import browser_agent as ba
    calls = []
    async def hung_wait(execute_fn, browser_id, tab_id, max_ms, **kw):
        return {"settled": False, "hung": True}
    monkeypatch.setattr(ba.browser_wait, "smart_wait", hung_wait)
    out = asyncio.run(ba.post_action_state(
        "BrowserClick", {"selector": "a"}, {"text": "Clicked"},
        "b1", "", p_fake_exec(calls), "",
    ))
    assert out == "" and calls == []


def test_delta_state_first_attach_sends_full_list():
    from backend.apps.agents.browser.browser_agent import delta_state
    seen = set()
    full = "8 interactive elements:\n" + "\n".join(f'[{i}]<button "b{i}">' for i in range(1, 9))
    assert delta_state(full, seen) == full
    assert len(seen) == 8


def test_delta_state_shrinks_to_changed_rows():
    from backend.apps.agents.browser.browser_agent import delta_state
    rows = [f'[{i}]<button "b{i}">' for i in range(1, 11)]
    seen = set()
    delta_state("\n".join(rows), seen)
    nxt = rows[:9] + ['[10]<button "b10" value="typed">', '[11]*<button "new">']
    out = delta_state("\n".join(nxt), seen)
    assert '[11]*<button "new">' in out and 'value="typed"' in out
    assert '[3]<button "b3">' not in out
    assert "+9 rows unchanged" in out
    assert seen == set(nxt)


def test_delta_state_no_changes_collapses_to_one_line():
    from backend.apps.agents.browser.browser_agent import delta_state
    rows = "\n".join(f'[{i}]<link "l{i}">' for i in range(1, 13))
    seen = set()
    delta_state(rows, seen)
    out = delta_state(rows, seen)
    assert out.startswith("(all 12 element rows unchanged")


def test_delta_state_reshuffle_resends_full():
    from backend.apps.agents.browser.browser_agent import delta_state
    seen = set()
    delta_state("\n".join(f'[{i}]<button "a{i}">' for i in range(1, 11)), seen)
    new_page = "10 interactive elements:\n" + "\n".join(f'[{i}]<button "z{i}">' for i in range(1, 11))
    assert delta_state(new_page, seen) == new_page


def test_informational_gate_judges_the_task_ask_first():
    from backend.apps.agents.browser.browser_loop import deliverable_is_informational
    chatty = (
        "The Wikipedia article on the Golden Gate Bridge is now open. The page has "
        "loaded successfully with the full article content visible, including links "
        "to related topics like suspension bridge, Golden Gate, and various related "
        "articles.\n\nOUTCOME: DONE - opened the article at https://en.wikipedia.org/wiki/Golden_Gate_Bridge"
    )
    action_task = "go to wikipedia and search for golden gate bridge and open the article"
    info_task = "go to hacker news and open the Ask section and tell me the title of the first question"
    assert not deliverable_is_informational(chatty, action_task)
    assert deliverable_is_informational("short answer", info_task)
    assert deliverable_is_informational(chatty, "open the page and tell me how many rows it shows")


def test_informational_gate_strips_outcome_boilerplate_on_tie_break():
    from backend.apps.agents.browser.browser_loop import deliverable_is_informational
    short_action = "Sent.\n\nOUTCOME: DONE - bubble visible at 12:05 PM with the exact text, composer cleared and Send greyed out which proves delivery"
    assert not deliverable_is_informational(short_action, "")
    listy = "Found these:\n- a\n- b\n- c"
    assert deliverable_is_informational(listy, "")


def test_find_me_and_most_viewed_asks_are_informational():
    from backend.apps.agents.browser.browser_loop import deliverable_is_informational
    # the exact MKBHD task that previously slipped past the gate ("find me" + "most viewed")
    assert deliverable_is_informational("", "find me his 50 most viewed vids")
    assert deliverable_is_informational("", "show me the top 10 trending repos")
    assert deliverable_is_informational("", "look up the cheapest flight")
    # a pure action ask still is not informational
    assert not deliverable_is_informational("", "send Tyler a message saying hi")


def test_interstitial_dismiss_target_generalizable_and_safe():
    from backend.apps.agents.browser.browser_loop import interstitial_dismiss_target
    # a junk popup with a throwaway-dismiss control gets found (any site)
    page = '\n'.join([
        '[3]<button "Try Premium for free">',
        '[4]<button "No thanks">',
        '[9]<textbox "Write a message…">',
    ])
    assert interstitial_dismiss_target(page) == "No thanks"
    # cookie/upsell variants
    assert interstitial_dismiss_target('[1]<button "Maybe later">') == "Maybe later"
    assert interstitial_dismiss_target('[1]<button "Not now">') == "Not now"
    assert interstitial_dismiss_target('[1]<link "Got it">') == "Got it"
    # NEVER dismisses task-needed or security/commit controls
    assert interstitial_dismiss_target('[1]<button "Send">') is None
    assert interstitial_dismiss_target('[1]<button "Message">') is None
    assert interstitial_dismiss_target('[1]<button "Close your conversation with Tyler">') is None
    assert interstitial_dismiss_target('[1]<button "Confirm">') is None
    assert interstitial_dismiss_target('[1]<button "Verify your identity">') is None
    # generic "Close"/"Dismiss"/"Skip" are NOT matched (they sit on needed dialogs)
    assert interstitial_dismiss_target('[1]<button "Close">') is None
    assert interstitial_dismiss_target('[1]<button "Skip">') is None
    # empty / no rows
    assert interstitial_dismiss_target('') is None
    assert interstitial_dismiss_target('just some text') is None


def test_recoverable_tool_error_classifier():
    from backend.apps.agents.browser.browser_loop import recoverable_tool_error
    # the action missed but the page is alive -> recoverable (attach fresh state)
    assert recoverable_tool_error("index 23 is no longer valid (No node with given id found). page may have changed")
    assert recoverable_tool_error("Clicked index 7 via its element (another element covered it)")
    assert recoverable_tool_error("element has no box model, try scrolling first")
    assert recoverable_tool_error("element not visible")
    # a DEAD card is NOT recoverable (handled by the card-gone path, no live page to read)
    assert not recoverable_tool_error("not an electron webview")
    assert not recoverable_tool_error("page unresponsive")
    assert not recoverable_tool_error("command timed out")
    # no error, or an unrelated one
    assert not recoverable_tool_error("")
    assert not recoverable_tool_error("some unrelated failure")


def test_message_pairing_validator_catches_both_orphan_and_dangling():
    from backend.apps.agents.browser.browser_history import validate_message_pairing
    au = lambda i: {"role": "assistant", "content": [{"type": "tool_use", "id": i, "name": "X", "input": {}}]}
    tr = lambda i: {"role": "user", "content": [{"type": "tool_result", "tool_use_id": i, "content": []}]}
    # well-formed: every tool_use answered
    assert validate_message_pairing([au("t1"), tr("t1")]) is True
    # DANGLING tool_use (the exact 400: a call with no result) -> invalid
    assert validate_message_pairing([au("t1")]) is False
    assert validate_message_pairing([au("t1"), tr("t1"), au("t2")]) is False
    # ORPHAN tool_result (result for a never-declared id) -> invalid
    assert validate_message_pairing([tr("ghost")]) is False
    # plain text turns are fine
    assert validate_message_pairing([{"role": "user", "content": "hi"},
                                      {"role": "assistant", "content": "done"}]) is True


def test_composer_fill_detection():
    # detecting a composer fill is what arms the post-type wait for the Send button to render before we re-list (so the model sees it instead of hunting)
    from backend.apps.agents.browser.browser_agent import is_composer_fill
    assert is_composer_fill("BrowserClickIndex", {"index": 4, "text": "hello world"})
    assert is_composer_fill("BrowserType", {"selector": "#m", "text": "hi"})
    assert is_composer_fill("BrowserBatch", {"actions": [
        {"type": "click_index", "params": {"index": 4, "text": "hi there"}}]})
    # a plain click (no text) is NOT a fill
    assert not is_composer_fill("BrowserClickIndex", {"index": 4})
    assert not is_composer_fill("BrowserScroll", {})


def test_send_index_handoff_points_only_at_a_real_send_button():
    # after a composer fill we hand the model the Send button's index so it clicks it directly instead of hunting; must never mistake an upsell/profile link for it
    from backend.apps.agents.browser.browser_agent import send_index_in_state
    page = '[1]<link "Tyler Chen">\n[33]<textbox "Write a message">\n[44]<button "Send">'
    assert send_index_in_state(page) == (44, "Send")
    assert send_index_in_state('[12]<button "Send InMail credit">') is None
    assert send_index_in_state('[5]<button "Send a message to Maya">') is None
    assert send_index_in_state("") is None


def test_strip_lone_surrogates():
    from backend.apps.agents.browser.browser_agent import strip_lone_surrogates, format_tool_result
    # an orphan UTF-16 surrogate (half an emoji from the webview) is what crashes the turn at .encode('utf-8'); it must be swapped, not carried through
    out = strip_lone_surrogates("Twitch \ud83e live")
    assert "\ud83e" not in out and "�" in out
    out.encode("utf-8")  # the operation that used to raise "surrogates not allowed"
    # valid emoji (a real code point) and plain text are left alone
    assert strip_lone_surrogates("cheese \U0001f9c0 ok") == "cheese \U0001f9c0 ok"
    assert strip_lone_surrogates("Search Amazon") == "Search Amazon"
    assert strip_lone_surrogates("") == ""
    # the boundary that feeds the model is sanitized for both result and error text
    blocks = format_tool_result({"text": "name \ud83e here"}, "BrowserListInteractives")
    blocks[0]["text"].encode("utf-8")
    err = format_tool_result({"error": "bad \ud83e node"}, "BrowserClickIndex")
    err[0]["text"].encode("utf-8")


def test_loop_tier_pin_flag_overrides_model_failsafe(monkeypatch):
    # V7: OPENSWARM_BROWSER_LOOP_TIER pins the loop to a fast-capable tier (provider-agnostic),
    # default off inherits the parent model, and a resolver failure falls back to the inherited id.
    import backend.apps.settings.credentials as cred_mod
    import backend.apps.agents.providers.registry as reg_mod
    BH.BROWSER_HISTORY.clear()
    primary = FakeLLM([Resp([Blk("text", "done")], stop_reason="end_turn")] * 5)
    p_install(monkeypatch, primary, FakeAux())

    async def p_tier_resolve(s, preferred_tier="haiku", primary_api=None):
        return (f"pinned-{preferred_tier}", None)
    monkeypatch.setattr(reg_mod, "resolve_aux_model", p_tier_resolve, raising=True)
    # same client whatever the id, so the loop runs and we can read which model it used
    monkeypatch.setattr(cred_mod, "get_anthropic_client_for_model", lambda s, m: primary, raising=True)

    # default OFF: inherit the parent's resolved id
    monkeypatch.delenv("OPENSWARM_BROWSER_LOOP_TIER", raising=False)
    asyncio.run(BA.run_browser_agent(task="t", browser_id="b1", model="opus", initial_url=None))
    assert primary.calls[-1]["model"] == "primary-x"

    # flag ON: pin to the fast-capable tier
    primary.turn = 0
    monkeypatch.setenv("OPENSWARM_BROWSER_LOOP_TIER", "sonnet")
    asyncio.run(BA.run_browser_agent(task="t", browser_id="b2", model="opus", initial_url=None))
    assert primary.calls[-1]["model"] == "pinned-sonnet"

    # fail-safe: resolver raises -> keep the inherited id, never break the run
    async def p_boom(s, preferred_tier="haiku", primary_api=None):
        raise RuntimeError("no provider")
    monkeypatch.setattr(reg_mod, "resolve_aux_model", p_boom, raising=True)
    primary.turn = 0
    asyncio.run(BA.run_browser_agent(task="t", browser_id="b3", model="opus", initial_url=None))
    assert primary.calls[-1]["model"] == "primary-x"
