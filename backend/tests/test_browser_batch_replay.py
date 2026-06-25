"""Intra-run batch replay: the pure validate / gate / fill core.

The highest-ghost-risk feature, so these pin down the two guarantees: (1) sends
are gated (never auto-looped), (2) the template fills correctly so a verified
replay is exact. Edge cases are deliberate, this is the 'no shadow of a doubt' set.
"""

from backend.apps.agents.browser import browser_batch_replay as br


# --- structural validation ---------------------------------------------------
def test_validate_rejects_empty_and_garbage():
    assert br.validate_template([])[0] is False
    assert br.validate_template("nope")[0] is False
    assert br.validate_template([{"action": "fly"}])[0] is False           # unknown action
    assert br.validate_template([{"action": "navigate"}])[0] is False      # missing url
    assert br.validate_template([{"action": "type", "selector": "#q"}])[0] is False  # missing text


def test_validate_accepts_a_well_formed_read_loop():
    ok, why = br.validate_template([
        {"action": "navigate", "url": "https://x.com/search?q={{value}}"},
        {"action": "get_text"},
    ])
    assert ok and why == ""


def test_validate_accepts_all_known_actions():
    steps = [
        {"action": "navigate", "url": "u"},
        {"action": "get_text"},
        {"action": "evaluate", "expression": "1"},
        {"action": "type", "selector": "#q", "text": "{{value}}"},
        {"action": "click", "role": "link", "name": "{{value}}"},
        {"action": "press_key", "key": "Enter"},
        {"action": "scroll", "direction": "down", "amount": 3},
        {"action": "replay_route", "url": "https://x.com/api?q={{value}}"},
    ]
    assert br.validate_template(steps)[0] is True


# --- the send gate (the safety guarantee) -----------------------------------
def test_send_and_submit_clicks_are_gated():
    for name in ["Send", "Send message", "Submit", "Connect", "Post", "Pay now",
                 "Buy", "Place order", "Delete", "Apply", "Follow", "Accept"]:
        safe, why = br.template_safety([
            {"action": "navigate", "url": "u"},
            {"action": "click", "role": "button", "name": name},
        ])
        assert safe is False, f"{name!r} must be gated"
        assert "irreversible" in why or "one at a time" in why


def test_typing_into_a_message_composer_is_gated():
    safe, _ = br.template_safety([
        {"action": "type", "selector": "div.msg-form__contenteditable", "text": "hi {{value}}"},
    ])
    assert safe is False


def test_pure_read_navigate_loop_is_safe():
    safe, why = br.template_safety([
        {"action": "navigate", "url": "https://x.com/in/{{value}}"},
        {"action": "get_text"},
        {"action": "evaluate", "expression": "document.title"},
    ])
    assert safe is True and why == ""


def test_a_benign_click_is_allowed_but_a_send_anywhere_gates_the_whole_thing():
    # clicking a non-send control (e.g. a result link) is fine to loop
    assert br.template_safety([{"action": "click", "role": "link", "name": "View profile"}])[0] is True
    # but ONE send step anywhere makes the whole template unsafe
    assert br.template_safety([
        {"action": "navigate", "url": "u"},
        {"action": "click", "role": "link", "name": "Open"},
        {"action": "click", "role": "button", "name": "Send invite"},
    ])[0] is False


# --- substitution (a verified replay is only as good as the fill) -----------
def test_fill_substitutes_value_everywhere():
    tool, params = br.fill_step({"action": "navigate", "url": "https://x.com/in/{{value}}/about"}, "ada")
    assert (tool, params) == ("BrowserNavigate", {"url": "https://x.com/in/ada/about"})

    tool, params = br.fill_step({"action": "type", "selector": "#q", "text": "{{value}} engineer"}, "design")
    assert params == {"selector": "#q", "text": "design engineer"}

    tool, params = br.fill_step({"action": "click", "role": "link", "name": "{{value}}"}, "Ada Lovelace")
    assert tool == "BrowserClickByName" and params == {"role": "link", "name": "Ada Lovelace"}


def test_replay_route_maps_to_the_fast_network_tool():
    tool, params = br.fill_step({"action": "replay_route", "url": "https://x.com/api/p?u={{value}}"}, "ada")
    assert tool == "BrowserReplayRoute" and params == {"url": "https://x.com/api/p?u=ada"}


def test_fill_handles_a_value_with_url_characters():
    # a value with spaces/specials is substituted literally (caller is responsible for encoding); we just don't mangle or drop it
    tool, params = br.fill_step({"action": "navigate", "url": "https://x.com/s?q={{value}}"}, "a b&c")
    assert params["url"] == "https://x.com/s?q=a b&c"


def test_fill_template_runs_every_step_per_value():
    steps = [{"action": "navigate", "url": "u/{{value}}"}, {"action": "get_text"}]
    filled = br.fill_template(steps, "x")
    assert [t for t, _ in filled] == ["BrowserNavigate", "BrowserGetText"]


def test_is_readonly_template():
    assert br.is_readonly_template([{"action": "navigate", "url": "u"}, {"action": "get_text"}])
    assert not br.is_readonly_template([{"action": "type", "selector": "#q", "text": "x"}])


# --- the data return: batch-read must hand back what it read ----------------
def test_summarize_returns_each_items_data():
    recs = [
        {"value": "ada", "ok": True, "text": "Ada Lovelace was a mathematician."},
        {"value": "grace", "ok": True, "text": "Grace Hopper was a computer scientist."},
    ]
    out = br.summarize_batch(recs, readonly=True)
    assert "Read 2 of 2." in out
    assert "ada: Ada Lovelace was a mathematician." in out
    assert "grace: Grace Hopper was a computer scientist." in out


def test_summarize_is_honest_about_failures_with_reasons():
    recs = [
        {"value": "ada", "ok": True, "text": "data"},
        {"value": "knuth", "ok": False, "text": "404 not found"},
    ]
    out = br.summarize_batch(recs, readonly=True)
    assert "Read 1 of 2." in out
    assert "knuth (404 not found)" in out
    assert "handle them individually" in out


def test_summarize_caps_each_item_and_total_without_silent_loss():
    big = "x" * 2000
    recs = [{"value": f"p{i}", "ok": True, "text": big} for i in range(30)]
    out = br.summarize_batch(recs, readonly=True, max_item_chars=100, max_total_chars=500)
    # each shown item is capped...
    assert "x" * 101 not in out
    # ...and the ones past the budget are NAMED as overflow, never silently dropped
    assert "more done but not shown" in out
    # every value is accounted for: shown bodies + overflow names cover all 30
    shown = out.count("- p")
    assert "+%d more" % (30 - shown) in out or "more done but not shown" in out


def test_summarize_action_loop_uses_completed_verb():
    recs = [{"value": "x", "ok": True, "text": "Clicked Save"}]
    assert br.summarize_batch(recs, readonly=False).startswith("Completed 1 of 1.")
    assert br.summarize_batch(recs, readonly=True).startswith("Read 1 of 1.")


def test_summarize_handles_empty_content():
    recs = [{"value": "x", "ok": True, "text": ""}]
    out = br.summarize_batch(recs, readonly=True)
    assert "x: (done, no content)" in out


# --- live batch send-guard ----------------------------------------------------
SEEN = {
    '[4] button "Send"',
    '[41] link "Next page"',
    '[7] button "Message"',
    '[12] button "Connect"',
}


def p_click_idx(i):
    return {"type": "click_index", "params": {"index": i}}


def test_guard_blocks_send_click_index_resolved_from_state():
    why = br.live_batch_guard([p_click_idx(4)], SEEN)
    assert "irreversible" in why and "Send" in why


def test_guard_blocks_connect_but_allows_message_composer_opener():
    assert br.live_batch_guard([p_click_idx(12)], SEEN) != ""
    assert br.live_batch_guard([p_click_idx(7)], SEEN) == ""


def test_guard_index_prefix_does_not_collide():
    # [4] is "Send" but [41] is "Next page"; clicking 41 must pass
    assert br.live_batch_guard([p_click_idx(41)], SEEN) == ""


def test_guard_allows_unresolvable_index_and_garbage():
    assert br.live_batch_guard([p_click_idx(99)], SEEN) == ""
    assert br.live_batch_guard([{"type": "click_index"}, "junk", None], SEEN) == ""
    assert br.live_batch_guard(None, set()) == ""


def test_guard_blocks_send_shaped_click_selector():
    why = br.live_batch_guard(
        [{"type": "click", "params": {"selector": "button.msg-form__send-button"}}], set())
    assert "irreversible" in why


def test_guard_blocks_enter_after_typing_into_composer():
    why = br.live_batch_guard([
        {"type": "type", "params": {"selector": "div.msg-form__contenteditable", "text": "hi"}},
        {"type": "press_key", "params": {"key": "Enter"}},
    ], set())
    assert "composer" in why


def test_guard_allows_search_type_then_enter():
    assert br.live_batch_guard([
        {"type": "type", "params": {"selector": "input.search-global-typeahead__input", "text": "q"}},
        {"type": "press_key", "params": {"key": "Enter"}},
    ], set()) == ""


# --- send payload extraction (recovery verify-first gate) -----------------------
def test_payload_extracted_from_composer_click_index_fill():
    log = [
        {"tool": "BrowserNavigate", "input": {"url": "https://x.com"}},
        {"tool": "BrowserClickIndex", "input": {"index": 4, "text": "[test] hello world r44-os"},
         "clicked_role": "textbox", "clicked_name": "Write a message…"},
    ]
    assert br.send_payload_from_log(log) == "[test] hello world r44-os"


def test_payload_ignores_search_fills_and_short_filter_textboxes():
    log = [
        {"tool": "BrowserClickIndex", "input": {"index": 2, "text": "tyler chen entrepreneurs"},
         "clicked_role": "searchbox", "clicked_name": "Search"},
        {"tool": "BrowserClickIndex", "input": {"index": 8, "text": "Entrepreneurs First"},
         "clicked_role": "textbox", "clicked_name": "Add a company"},
    ]
    assert br.send_payload_from_log(log) == ""


def test_payload_from_type_and_batch_composer_selectors_longest_wins():
    log = [
        {"tool": "BrowserType", "input": {"selector": "div.msg-form__contenteditable", "text": "hi"}},
        {"tool": "BrowserBatch", "input": {"actions": [
            {"type": "type", "params": {"selector": "div.msg-form__contenteditable",
                                        "text": "a much longer message body"}},
            {"type": "type", "params": {"selector": "input.search-typeahead", "text": "ignored search"}},
        ]}},
    ]
    assert br.send_payload_from_log(log) == "a much longer message body"


def test_payload_empty_log_and_garbage_safe():
    assert br.send_payload_from_log([]) == ""
    assert br.send_payload_from_log(None) == ""
    assert br.send_payload_from_log([{"tool": "BrowserClickIndex"}, "junk"]) == ""


def test_payload_extracted_from_focus_type_click_without_clicked_fields():
    # r47's live miss: focus+type results carry no clickedRole/clickedName
    log = [{
        "tool": "BrowserClickIndex",
        "input": {"index": 1, "text": "[test] hello world r47-os"},
        "result_summary": 'Focused index 1 and typed the text in (via editor command). Verified: the box now contains "[test] hello world r47-os". Do NOT type it again.',
        "clicked_role": None, "clicked_name": None,
    }]
    assert br.send_payload_from_log(log) == "[test] hello world r47-os"


def test_payload_prefers_prompt_quoted_candidate_over_garbled_retype():
    clean = "[test] hello world r47-os"
    garbled = "[test] hello world r47-os\n[test] hello world r47-os"
    log = [
        {"tool": "BrowserClickIndex", "input": {"index": 1, "text": clean},
         "result_summary": "typed the text in", "clicked_role": "textbox", "clicked_name": ""},
        {"tool": "BrowserClickIndex", "input": {"index": 1, "text": garbled},
         "result_summary": "typed the text in", "clicked_role": "textbox", "clicked_name": ""},
    ]
    prompt = f"go to tyler chen's linkedin and text him '{clean}'"
    assert br.send_payload_from_log(log, prompt) == clean
    assert br.send_payload_from_log(log) == garbled


def test_payload_from_index_based_batch_type():
    log = [{
        "tool": "BrowserBatch",
        "input": {"actions": [
            {"type": "click_index", "params": {"index": 4}},
            {"type": "type", "params": {"index": 4, "text": "[test] hello world long enough"}},
        ]},
    }]
    assert br.send_payload_from_log(log) == "[test] hello world long enough"


def test_guard_blocks_batched_enter_when_composer_pending():
    actions = [
        {"type": "press_key", "params": {"key": "Enter"}},
        {"type": "wait", "params": {"milliseconds": 3000}},
    ]
    why = br.live_batch_guard(actions, [], composer_pending=True)
    assert "Enter" in why
    assert br.live_batch_guard(actions, [], composer_pending=False) == ""


def test_guard_still_allows_search_type_enter_without_pending_composer():
    actions = [
        {"type": "type", "params": {"selector": "input[name=q]", "text": "tyler chen"}},
        {"type": "press_key", "params": {"key": "Enter"}},
    ]
    assert br.live_batch_guard(actions, [], composer_pending=False) == ""
