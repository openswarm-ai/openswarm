"""Browser skill cache: normalization, distillation, record/find, persistence, redaction."""

import os
import tempfile

import pytest

from backend.apps.agents.browser import browser_skills as sk


@pytest.fixture(autouse=True)
def p_isolated_skills(monkeypatch):
    # Persist to a throwaway dir so tests never touch the real DATA_ROOT.
    d = tempfile.mkdtemp(prefix="skills_test_")
    monkeypatch.setenv("OPENSWARM_BROWSER_SKILLS_DIR", d)
    sk.clear(wipe_disk=True)
    yield d
    sk.clear(wipe_disk=True)


def test_normalize_task_is_stable_across_rewordings():
    a = sk.normalize_task('Go to http://x.com/form and type "hi" into the box, then click Send.')
    b = sk.normalize_task('type "hi" into the box click Send')
    # urls, punctuation, and filler words drop out; core tokens remain
    assert "send" in a and "type" in a and "http" not in a
    assert a == b


def test_host_of():
    assert sk.host_of("http://localhost:8901/form.html") == "localhost:8901"
    assert sk.host_of("https://docs.google.com/x") == "docs.google.com"


def p_log():
    return [
        {"tool": "BrowserScreenshot", "input": {}, "ok": False},
        {"tool": "BrowserNavigate", "input": {"url": "http://h/form"}, "ok": True},
        {"tool": "BrowserType", "input": {"selector": "#msg", "text": "hello world"}, "ok": True},
        {"tool": "BrowserGetText", "input": {}, "ok": True},
        {"tool": "BrowserClickIndex", "input": {"index": 3}, "ok": True,
         "clicked_role": "button", "clicked_name": "Send"},
    ]


def test_distill_builds_robust_steps():
    steps = sk.distill_steps(p_log())
    tools = [s["tool"] for s in steps]
    # reads/screenshots dropped; click_index becomes a robust click-by-name
    assert tools == ["BrowserNavigate", "BrowserType", "BrowserClickByName"]
    cbn = steps[-1]
    assert cbn["params"] == {"role": "button", "name": "Send"}


def test_distill_refuses_click_without_resolved_name():
    log = [
        {"tool": "BrowserNavigate", "input": {"url": "http://h/"}, "ok": True},
        {"tool": "BrowserClickIndex", "input": {"index": 2}, "ok": True},  # no clicked_name
    ]
    # a click we can't make robust -> no skill at all (don't record a flaky one)
    assert sk.distill_steps(log) == []


def test_distill_skips_navigate_only():
    log = [{"tool": "BrowserNavigate", "input": {"url": "http://h/"}, "ok": True}]
    assert sk.distill_steps(log) == []


def test_distill_skips_failed_steps():
    log = [
        {"tool": "BrowserType", "input": {"selector": "#m", "text": "x"}, "ok": True},
        {"tool": "BrowserClick", "input": {"selector": ".gone"}, "ok": False},
    ]
    steps = sk.distill_steps(log)
    assert [s["tool"] for s in steps] == ["BrowserType"]


def test_distill_flattens_browser_batch():
    # the agent's efficient path bundles type+press_key into one BrowserBatch; the recorder must flatten those into discrete robust steps.
    log = [
        {"tool": "BrowserNavigate", "input": {"url": "http://h/form"}, "ok": True},
        {"tool": "BrowserBatch", "ok": True, "input": {"actions": [
            {"type": "type", "params": {"selector": "#msg", "text": "hello world"}},
            {"type": "press_key", "params": {"key": "Enter"}},
        ]}},
    ]
    steps = sk.distill_steps(log)
    assert [s["tool"] for s in steps] == ["BrowserNavigate", "BrowserType", "BrowserPressKey"]
    assert steps[1]["params"]["text"] == "hello world"


def test_distill_bails_on_batched_click_index():
    # a batched click_index can't be made robust (resolved name not recoverable)
    log = [
        {"tool": "BrowserBatch", "ok": True, "input": {"actions": [
            {"type": "type", "params": {"selector": "#m", "text": "x"}},
            {"type": "click_index", "params": {"index": 2}},
        ]}},
    ]
    assert sk.distill_steps(log) == []


def test_record_and_find_roundtrip():
    assert sk.record_skill("localhost:8901", "type hello and click Send", p_log()) is True
    found = sk.find_skill("localhost:8901", "Please type hello and click Send")
    assert found is not None
    assert [s["tool"] for s in found["steps"]] == ["BrowserNavigate", "BrowserType", "BrowserClickByName"]


def test_find_is_host_scoped():
    sk.record_skill("a.com", "do thing now", p_log())
    assert sk.find_skill("b.com", "do thing now") is None


def test_record_refuses_unrecordable_run():
    # navigate-only -> nothing stored
    assert sk.record_skill("h", "just go", [{"tool": "BrowserNavigate", "input": {"url": "http://h/"}, "ok": True}]) is False
    assert sk.find_skill("h", "just go") is None


# --- persistence + redaction ----------------------------------------------
def test_skill_persists_across_restart(p_isolated_skills):
    # record, then simulate a process restart by wiping ONLY the in-memory cache; find must re-load it from disk.
    assert sk.record_skill("localhost:8901", "type hello and click Send", p_log()) is True
    sk.clear(wipe_disk=False)            # in-memory gone, disk intact (== restart)
    assert not sk.SKILLS                # cache truly empty
    found = sk.find_skill("localhost:8901", "type hello and click Send")
    assert found is not None and found.get("persisted") is True
    assert [s["tool"] for s in found["steps"]] == ["BrowserNavigate", "BrowserType", "BrowserClickByName"]


def test_sensitive_text_is_NOT_persisted(p_isolated_skills):
    # a skill that types an email/password must stay in-memory only (no disk file)
    log = [
        {"tool": "BrowserType", "input": {"selector": "#email", "text": "eric@example.com"}, "ok": True},
        {"tool": "BrowserClickIndex", "input": {}, "ok": True, "clicked_role": "button", "clicked_name": "Submit"},
    ]
    assert sk.record_skill("site.com", "enter email and submit", log) is True   # stored in memory
    # nothing on disk for this skill
    path = sk.skill_path("site.com", sk.normalize_task("enter email and submit"))
    assert path is not None and not os.path.exists(path)
    # and after a "restart" it's gone (was never persisted)
    sk.clear(wipe_disk=False)
    assert sk.find_skill("site.com", "enter email and submit") is None


def test_password_field_selector_blocks_persistence(p_isolated_skills):
    log = [
        {"tool": "BrowserType", "input": {"selector": "input#password", "text": "hunter2"}, "ok": True},
        {"tool": "BrowserClickIndex", "input": {}, "ok": True, "clicked_role": "button", "clicked_name": "Log in"},
    ]
    sk.record_skill("site.com", "log in", log)
    assert not os.path.exists(sk.skill_path("site.com", sk.normalize_task("log in")))


def test_sensitivity_detector():
    assert sk.looks_sensitive("eric@example.com")
    assert sk.looks_sensitive("4111 1111 1111 1111")          # card-shaped
    assert sk.looks_sensitive("123-45-6789")                  # ssn
    assert sk.looks_sensitive("sk-ant-api03-abc123")          # token prefix
    assert sk.looks_sensitive("anything", selector="#pwd")    # password field
    assert sk.looks_sensitive("aB3xK9mQ2pL7wR4tY8nZ")         # long high-entropy
    assert not sk.looks_sensitive("hello world")
    assert not sk.looks_sensitive("openswarm", selector="#search")


def test_navigate_url_userinfo_and_fragment_stripped_on_disk(p_isolated_skills):
    log = [
        {"tool": "BrowserNavigate", "input": {"url": "https://user:pw@site.com/app?q=1#frag"}, "ok": True},
        {"tool": "BrowserType", "input": {"selector": "#q", "text": "shoes"}, "ok": True},
    ]
    # userinfo in the URL makes the whole skill non-persistable (credentialed URL)
    sk.record_skill("site.com", "search shoes", log)
    assert not os.path.exists(sk.skill_path("site.com", sk.normalize_task("search shoes")))
    # but a clean URL with a fragment persists with the fragment stripped
    log2 = [
        {"tool": "BrowserNavigate", "input": {"url": "https://site.com/app#section"}, "ok": True},
        {"tool": "BrowserType", "input": {"selector": "#q", "text": "shoes"}, "ok": True},
    ]
    assert sk.record_skill("site.com", "search for shoes here", log2) is True
    sk.clear(wipe_disk=False)
    found = sk.find_skill("site.com", "search for shoes here")
    assert found is not None
    nav = next(s for s in found["steps"] if s["tool"] == "BrowserNavigate")
    assert "#section" not in nav["params"]["url"]


def test_format_version_mismatch_is_ignored(p_isolated_skills, monkeypatch):
    sk.record_skill("v.com", "do a thing now", p_log())
    sk.clear(wipe_disk=False)
    monkeypatch.setattr(sk, "P_SKILL_FORMAT_VERSION", 999)  # pretend the format moved on
    assert sk.find_skill("v.com", "do a thing now") is None


# --- parameterization: "same task, different input" -----------------------
def test_quoted_value_becomes_a_slot_and_reuses_across_inputs(p_isolated_skills):
    # learn from a task with a quoted value
    log = [
        {"tool": "BrowserNavigate", "input": {"url": "https://shop.com/search"}, "ok": True},
        {"tool": "BrowserType", "input": {"selector": "#q", "text": "running shoes"}, "ok": True},
        {"tool": "BrowserClickIndex", "input": {}, "ok": True, "clicked_role": "button", "clicked_name": "Search"},
    ]
    assert sk.record_skill("shop.com", 'search for "running shoes"', log) is True
    # a DIFFERENT quoted input matches the SAME skill (templated key)
    found = sk.find_skill("shop.com", 'search for "winter boots"')
    assert found is not None
    concrete = sk.rehydrate(found, 'search for "winter boots"')
    type_step = next(s for s in concrete if s["tool"] == "BrowserType")
    assert type_step["params"]["text"] == "winter boots"   # filled from the NEW task


def test_parameterized_value_is_not_persisted(p_isolated_skills):
    log = [
        {"tool": "BrowserType", "input": {"selector": "#q", "text": "running shoes"}, "ok": True},
        {"tool": "BrowserClickIndex", "input": {}, "ok": True, "clicked_role": "button", "clicked_name": "Search"},
    ]
    sk.record_skill("shop.com", 'search for "running shoes"', log)
    path = sk.skill_path("shop.com", sk.compute_sig('search for "running shoes"'))
    blob = open(path).read()
    assert "running shoes" not in blob   # the quoted value never hits disk
    assert '"value_slot": 0' in blob or '"value_slot":0' in blob


def test_rehydrate_aborts_when_slot_cannot_be_filled(p_isolated_skills):
    log = [
        {"tool": "BrowserType", "input": {"selector": "#q", "text": "shoes"}, "ok": True},
        {"tool": "BrowserClickIndex", "input": {}, "ok": True, "clicked_role": "button", "clicked_name": "Go"},
    ]
    sk.record_skill("shop.com", 'search for "shoes"', log)
    found = sk.find_skill("shop.com", "search for shoes")  # no quotes -> no value to fill
    # find still matches if signatures align; rehydrate must refuse (no ghost)
    if found is not None:
        assert sk.rehydrate(found, "search for shoes") is None


def test_unquoted_text_stays_literal_backward_compatible(p_isolated_skills):
    # no quotes -> behaves exactly as before (literal text, exact-ish key)
    assert sk.record_skill("localhost:8901", "type hello and click Send", p_log()) is True
    found = sk.find_skill("localhost:8901", "Please type hello and click Send")
    assert found is not None
    concrete = sk.rehydrate(found, "Please type hello and click Send")
    type_step = next(s for s in concrete if s["tool"] == "BrowserType")
    assert type_step["params"]["text"] == "hello world"   # literal, unchanged


# --- skill self-awareness (list / deprecate) ------------------------------
def test_list_skills_for_host(p_isolated_skills):
    sk.record_skill("shop.com", "search for shoes now", p_log())
    sk.record_skill("shop.com", "add item to the cart now", p_log())
    sk.record_skill("other.com", "do a thing now", p_log())
    listed = sk.list_skills("shop.com")
    tasks = {x["task"] for x in listed}
    assert len(listed) == 2 and all("steps" in x and "replays" in x for x in listed)
    assert not any(t for t in tasks if t in sk.list_skills("other.com"))  # host-scoped


def test_list_skills_reads_disk_after_restart(p_isolated_skills):
    sk.record_skill("shop.com", "search for shoes now", p_log())
    sk.clear(wipe_disk=False)               # restart: memory gone, disk intact
    assert len(sk.list_skills("shop.com")) == 1


def test_deprecate_removes_skill_from_memory_and_disk(p_isolated_skills):
    sk.record_skill("shop.com", "search for shoes now", p_log())
    sig = sk.compute_sig("search for shoes now")
    assert os.path.exists(sk.skill_path("shop.com", sig))
    # deprecate using the task_sig as list_skills would surface it
    assert sk.deprecate_skill("shop.com", sig) is True
    assert not os.path.exists(sk.skill_path("shop.com", sig))
    assert sk.find_skill("shop.com", "search for shoes now") is None


def test_deprecate_unknown_is_false(p_isolated_skills):
    assert sk.deprecate_skill("shop.com", "never recorded this") is False


# --- versioned safe-edit: the trust gate ---------------------------------- A skill is never trusted until a real replay proves it; an unproven skill that fails is quarantined (never replayed again) so a lossy skill can't ghost-succeed or run slower-than-baseline; re-deriving different steps is a re-versioned EDIT.

def test_new_skill_starts_on_probation(p_isolated_skills):
    sk.record_skill("shop.com", "do a thing now", p_log())
    s = sk.find_skill("shop.com", "do a thing now")
    assert s["state"] == sk.PROBATION and s["rev"] == 1 and s["replays"] == 0


def test_replay_success_promotes_probation_to_trusted(p_isolated_skills):
    sk.record_skill("shop.com", "do a thing now", p_log())
    sk.mark_replay_succeeded("shop.com", "do a thing now")
    s = sk.find_skill("shop.com", "do a thing now")
    assert s["state"] == sk.TRUSTED and s["replays"] == 1 and s["fails"] == 0


def test_probation_failure_quarantines_and_blocks_future_replay(p_isolated_skills):
    sk.record_skill("shop.com", "do a thing now", p_log())          # probation
    verdict = sk.mark_replay_failed("shop.com", "do a thing now")
    assert verdict == "quarantined"
    # the ghost guard: a quarantined skill is NEVER handed back for replay...
    assert sk.find_skill("shop.com", "do a thing now") is None
    # ...but the record still exists (visible + deprecatable), it just won't run
    listed = sk.list_skills("shop.com")
    assert len(listed) == 1 and listed[0]["state"] == sk.QUARANTINE


def test_quarantined_skill_re_recorded_identical_stays_quarantined(p_isolated_skills):
    sk.record_skill("shop.com", "do a thing now", p_log())
    sk.mark_replay_failed("shop.com", "do a thing now")            # quarantined
    # the full LLM agent re-runs and distills the SAME (still-lossy) steps:
    sk.record_skill("shop.com", "do a thing now", p_log())
    # it must stay quarantined -> pure-LLM baseline, never a wasted replay again
    assert sk.find_skill("shop.com", "do a thing now") is None
    assert sk.list_skills("shop.com")[0]["state"] == sk.QUARANTINE


def test_quarantined_skill_unquarantines_on_a_real_edit(p_isolated_skills):
    sk.record_skill("shop.com", "do a thing now", p_log())
    sk.mark_replay_failed("shop.com", "do a thing now")            # quarantined
    # now the page changed and the LLM derives a DIFFERENT click -> a real edit, which earns the skill another chance (back on probation, re-versioned)
    edited = p_log()[:-1] + [{"tool": "BrowserClickIndex", "input": {}, "ok": True,
                             "clicked_role": "button", "clicked_name": "Submit"}]
    sk.record_skill("shop.com", "do a thing now", edited)
    s = sk.find_skill("shop.com", "do a thing now")
    assert s is not None and s["state"] == sk.PROBATION and s["rev"] == 2


def test_trusted_skill_tolerates_one_transient_miss_then_demotes(p_isolated_skills):
    sk.record_skill("shop.com", "do a thing now", p_log())
    sk.mark_replay_succeeded("shop.com", "do a thing now")         # trusted
    assert sk.mark_replay_failed("shop.com", "do a thing now") == "kept"
    s = sk.find_skill("shop.com", "do a thing now")
    assert s["state"] == sk.TRUSTED and s["fails"] == 1           # still usable
    assert sk.mark_replay_failed("shop.com", "do a thing now") == "demoted"
    assert sk.find_skill("shop.com", "do a thing now")["state"] == sk.PROBATION


def test_re_record_identical_keeps_trust_and_rev(p_isolated_skills):
    sk.record_skill("shop.com", "do a thing now", p_log())
    sk.mark_replay_succeeded("shop.com", "do a thing now")
    sk.find_skill("shop.com", "do a thing now")["replays"] = 5     # pretend reused a lot
    sk.record_skill("shop.com", "do a thing now", p_log())          # identical re-derive
    s = sk.find_skill("shop.com", "do a thing now")
    assert s["state"] == sk.TRUSTED and s["rev"] == 1 and s["replays"] == 5


def test_re_record_different_is_an_edit_that_reversions_to_probation(p_isolated_skills):
    sk.record_skill("shop.com", "do a thing now", p_log())
    sk.mark_replay_succeeded("shop.com", "do a thing now")         # trusted, rev 1
    edited = p_log()[:-1] + [{"tool": "BrowserClickIndex", "input": {}, "ok": True,
                             "clicked_role": "button", "clicked_name": "Submit"}]
    sk.record_skill("shop.com", "do a thing now", edited)          # different -> EDIT
    s = sk.find_skill("shop.com", "do a thing now")
    assert s["rev"] == 2 and s["state"] == sk.PROBATION and s["replays"] == 0
    cbn = next(x for x in s["steps"] if x["tool"] == "BrowserClickByName")
    assert cbn["params"]["name"] == "Submit"                       # the new step stuck


def test_rev_and_state_persist_across_restart(p_isolated_skills):
    sk.record_skill("shop.com", "do a thing now", p_log())
    sk.mark_replay_succeeded("shop.com", "do a thing now")
    edited = p_log()[:-1] + [{"tool": "BrowserClickIndex", "input": {}, "ok": True,
                             "clicked_role": "button", "clicked_name": "Submit"}]
    sk.record_skill("shop.com", "do a thing now", edited)          # rev 2, probation
    sk.clear(wipe_disk=False)                                      # restart
    s = sk.find_skill("shop.com", "do a thing now")
    assert s["rev"] == 2 and s["state"] == sk.PROBATION


def test_steps_equal_distinguishes_slot_from_literal_and_changed_click():
    nav = {"tool": "BrowserNavigate", "params": {"url": "https://x.com/a#frag"}}
    nav2 = {"tool": "BrowserNavigate", "params": {"url": "https://x.com/a"}}   # frag stripped == same
    lit = {"tool": "BrowserType", "params": {"selector": "#q", "text": "shoes"}}
    slot = {"tool": "BrowserType", "params": {"selector": "#q", "value_slot": 0}}
    send = {"tool": "BrowserClickByName", "params": {"role": "button", "name": "Send"}}
    submit = {"tool": "BrowserClickByName", "params": {"role": "button", "name": "Submit"}}
    assert sk.steps_equal([nav], [nav2])           # fragment-only diff is NOT an edit
    assert not sk.steps_equal([lit], [slot])       # literal vs parameterized IS an edit
    assert not sk.steps_equal([send], [submit])    # renamed button IS an edit


def test_mark_replay_helpers_on_unknown_are_safe(p_isolated_skills):
    sk.mark_replay_succeeded("shop.com", "never recorded")    # no raise
    assert sk.mark_replay_failed("shop.com", "never recorded") == "none"


def test_demoted_skill_can_be_re_proven(p_isolated_skills):
    sk.record_skill("shop.com", "do a thing now", p_log())
    sk.mark_replay_succeeded("shop.com", "do a thing now")    # trusted
    sk.mark_replay_failed("shop.com", "do a thing now")
    sk.mark_replay_failed("shop.com", "do a thing now")       # demoted to probation
    assert sk.find_skill("shop.com", "do a thing now")["state"] == sk.PROBATION
    sk.mark_replay_succeeded("shop.com", "do a thing now")    # earns trust back
    assert sk.find_skill("shop.com", "do a thing now")["state"] == sk.TRUSTED


# --- composition: build on what's already proven, propagate staleness -------

def p_log_plus():
    # distills to p_log()'s 3 steps PLUS a 4th click -> a strict superset sequence
    return p_log() + [{"tool": "BrowserClickIndex", "input": {}, "ok": True,
                      "clicked_role": "button", "clicked_name": "Checkout"}]


def p_trust(host, task, log):
    sk.record_skill(host, task, log)
    sk.mark_replay_succeeded(host, task)


def test_composition_links_to_trusted_sub_skill(p_isolated_skills):
    p_trust("shop.com", "search shoes now", p_log())                # trusted foundation
    sk.record_skill("shop.com", "search shoes and checkout now", p_log_plus())
    c = sk.find_skill("shop.com", "search shoes and checkout now")
    assert c["composed_of"] == [sk.compute_sig("search shoes now")]


def test_composition_ignores_untrusted_foundation(p_isolated_skills):
    sk.record_skill("shop.com", "search shoes now", p_log())        # probation, NOT trusted
    sk.record_skill("shop.com", "search shoes and checkout now", p_log_plus())
    c = sk.find_skill("shop.com", "search shoes and checkout now")
    assert c["composed_of"] == []          # only a PROVEN sub-skill is built upon


def test_deprecating_a_foundation_demotes_everything_built_on_it(p_isolated_skills):
    p_trust("shop.com", "search shoes now", p_log())
    p_trust("shop.com", "search shoes and checkout now", p_log_plus())   # composed + trusted
    assert sk.find_skill("shop.com", "search shoes and checkout now")["state"] == sk.TRUSTED
    sk.deprecate_skill("shop.com", "search shoes now")            # foundation pulled
    # the ghost guard for composition: the dependent must NOT stay trusted on a foundation that no longer exists; it's knocked back to re-prove
    assert sk.find_skill("shop.com", "search shoes and checkout now")["state"] == sk.PROBATION


def test_demoting_a_foundation_demotes_its_dependents(p_isolated_skills):
    p_trust("shop.com", "search shoes now", p_log())
    p_trust("shop.com", "search shoes and checkout now", p_log_plus())
    sk.mark_replay_failed("shop.com", "search shoes now")
    sk.mark_replay_failed("shop.com", "search shoes now")         # foundation demoted
    assert sk.find_skill("shop.com", "search shoes and checkout now")["state"] == sk.PROBATION


def test_editing_a_foundation_demotes_its_dependents(p_isolated_skills):
    p_trust("shop.com", "search shoes now", p_log())
    p_trust("shop.com", "search shoes and checkout now", p_log_plus())
    edited = p_log()[:-1] + [{"tool": "BrowserClickIndex", "input": {}, "ok": True,
                             "clicked_role": "button", "clicked_name": "Find"}]
    sk.record_skill("shop.com", "search shoes now", edited)       # foundation changed
    assert sk.find_skill("shop.com", "search shoes and checkout now")["state"] == sk.PROBATION


def test_list_skills_surfaces_state_rev_and_builds_on(p_isolated_skills):
    p_trust("shop.com", "search shoes now", p_log())
    sk.record_skill("shop.com", "search shoes and checkout now", p_log_plus())
    listed = {x["task"]: x for x in sk.list_skills("shop.com")}
    foundation = listed[sk.compute_sig("search shoes now")]
    composed = listed[sk.compute_sig("search shoes and checkout now")]
    assert foundation["state"] == sk.TRUSTED and foundation["builds_on"] == []
    assert composed["builds_on"] == [sk.compute_sig("search shoes now")]
    assert "rev" in composed and "steps" in composed


def test_replay_safety_refuses_send_steps_and_passes_reads():
    safe, _ = sk.replay_safety([
        {"tool": "BrowserNavigate", "params": {"url": "https://a.com"}},
        {"tool": "BrowserClickByName", "params": {"role": "button", "name": "Search"}},
        {"tool": "BrowserPressKey", "params": {"key": "Enter"}},
    ])
    assert safe is True
    for bad in (
        [{"tool": "BrowserClickByName", "params": {"role": "button", "name": "Send"}}],
        [{"tool": "BrowserClickByName", "params": {"role": "button", "name": "Place order"}}],
        [{"tool": "BrowserClick", "params": {"selector": "button[aria-label='Submit form']"}}],
        [{"tool": "BrowserType", "params": {"selector": "#message-body", "text": "hi"}}],
    ):
        ok, why = sk.replay_safety(bad)
        assert ok is False and "irreversible" in why


def test_extract_first_json_strips_fences_and_prose():
    from backend.apps.agents.browser.browser_extract import first_json
    assert first_json('```json\n{"a": 1}\n```') == '{"a": 1}'
    assert first_json('Here you go: [{"n": "x"}] hope that helps') == '[{"n": "x"}]'
    assert first_json("no json here") == ""
    assert first_json('{"broken": ') == ""


def test_widened_redaction_catches_audit_bypasses():
    # the audit's three named bypasses: bare 2FA digits, credential-shaped fields the old regex missed, and seed/recovery phrase boxes
    assert sk.looks_sensitive("481922", "")
    assert sk.looks_sensitive("hunter2", "#user")
    assert sk.looks_sensitive("me@corp.com", "#login-email")
    assert sk.looks_sensitive("correct horse battery staple", "#seed-phrase")
    assert sk.looks_sensitive("123456", "input[name='verification-code']")
    # the bread-and-butter skill (a search query) still persists
    assert not sk.looks_sensitive("shoes", "#search-input")
    assert not sk.looks_sensitive("Ada Lovelace", ".search-global-typeahead input")


def test_first_unsafe_step_splits_send_skills():
    from backend.apps.agents.browser.browser_skills import first_unsafe_step, replay_safety
    nav_only = [
        {"tool": "BrowserNavigate", "params": {"url": "https://x.com"}},
        {"tool": "BrowserClickByName", "params": {"name": "Profile link"}},
    ]
    assert first_unsafe_step(nav_only) == (-1, "")
    assert replay_safety(nav_only) == (True, "")

    send_flow = nav_only + [
        {"tool": "BrowserClickByName", "params": {"name": "Send"}},
    ]
    i, why = first_unsafe_step(send_flow)
    assert i == 2 and "irreversible" in why
    safe, _ = replay_safety(send_flow)
    assert not safe


def test_template_task_ignores_possessive_apostrophes():
    from backend.apps.agents.browser.browser_skills import template_task, compute_sig
    r14 = "go to tyler chen's linkedin hes in entrepreneurs first and text him '[test] hello world r14-os'"
    r15 = "go to tyler chen's linkedin hes in entrepreneurs first and text him '[test] hello world r15-os'"
    t14, v14 = template_task(r14)
    assert v14 == ["[test] hello world r14-os"]
    assert "chen's linkedin" in t14
    assert compute_sig(r14) == compute_sig(r15)
    assert template_task("no quotes here at all") == ("no quotes here at all", [])


def test_long_card_blob_click_names_are_not_send_steps():
    from backend.apps.agents.browser.browser_skills import first_unsafe_step
    flow = [
        {"tool": "BrowserNavigate", "params": {"url": "https://www.linkedin.com/search"}},
        {"tool": "BrowserClickByName", "params": {"name": (
            "Tyler Chen Premium • 1st Something Here Irvine, California, United States Send a message to Tyler"
        )}},
        {"tool": "BrowserClickByName", "params": {"name": "Message"}},
        {"tool": "BrowserClickByName", "params": {"name": "Send"}},
    ]
    i, why = first_unsafe_step(flow)
    # the 100ch blob at step 1 isn't flagged (len guard); the composer OPENER "Message" at step 2 isn't either (reversible, it just opens the box); the boundary is the real "Send" at step 3, so the prefix can open the composer.
    assert i == 3, f"expected the Send click flagged, got {i}: {why}"


def test_composer_opener_is_not_the_replay_boundary():
    from backend.apps.agents.browser.browser_skills import first_unsafe_step, replay_safety
    # clicking "Message"/"DM" just OPENS the composer (reversible); the boundary is the real Send, so the open-the-composer steps can mechanically replay.
    flow = [
        {"tool": "BrowserClickByName", "params": {"role": "link", "name": "Message"}},
        {"tool": "BrowserClickByName", "params": {"role": "textbox", "name": "Write a message…"}},
        {"tool": "BrowserClickByName", "params": {"role": "button", "name": "Send"}},
    ]
    i, why = first_unsafe_step(flow)
    assert i == 2 and "irreversible" in why  # the Send (step 3), not Message
    # a skill that only OPENS a composer (no send) is fully safe to replay
    opener_only = flow[:2]
    assert first_unsafe_step(opener_only) == (-1, "")
    assert replay_safety(opener_only) == (True, "")


def test_distill_maps_batched_click_index_to_click_by_name():
    from backend.apps.agents.browser.browser_skills import distill_steps
    entry = {
        "tool": "BrowserBatch", "ok": True,
        "input": {"actions": [
            {"type": "navigate", "params": {"url": "https://x.com/search"}},
            {"type": "click_index", "params": {"index": 3}},
            {"type": "list_interactives", "params": {}},
        ]},
        "sub_results": [
            {"index": 0, "ok": True, "clicked_role": None, "clicked_name": None},
            {"index": 1, "ok": True, "clicked_role": "link", "clicked_name": "Profile"},
            {"index": 2, "ok": True, "clicked_role": None, "clicked_name": None},
        ],
    }
    steps = distill_steps([entry])
    assert [s["tool"] for s in steps] == ["BrowserNavigate", "BrowserClickByName"]
    assert steps[1]["params"]["name"] == "Profile"


def test_distill_batch_aborted_tail_and_missing_identities():
    from backend.apps.agents.browser.browser_skills import distill_steps
    aborted = {
        "tool": "BrowserBatch", "ok": True,
        "input": {"actions": [
            {"type": "navigate", "params": {"url": "https://x.com"}},
            {"type": "type", "params": {"selector": "#q", "text": "hi"}},
            {"type": "click_index", "params": {"index": 9}},
        ]},
        "sub_results": [
            {"index": 0, "ok": True, "clicked_role": None, "clicked_name": None},
            {"index": 1, "ok": True, "clicked_role": None, "clicked_name": None},
        ],
    }
    assert [s["tool"] for s in distill_steps([aborted])] == ["BrowserNavigate", "BrowserType"]

    nameless_click = {
        "tool": "BrowserBatch", "ok": True,
        "input": {"actions": [{"type": "click_index", "params": {"index": 2}}]},
        "sub_results": [{"index": 0, "ok": True, "clicked_role": "", "clicked_name": ""}],
    }
    assert distill_steps([nameless_click]) == []

    old_shape = {
        "tool": "BrowserBatch", "ok": True,
        "input": {"actions": [{"type": "click_index", "params": {"index": 1}}]},
    }
    assert distill_steps([old_shape]) == []


# --- route hints (advisory reuse when replay can't run) ---------------------
def p_record_dm_skill(host="www.linkedin.com"):
    log = [
        {"tool": "BrowserNavigate", "input": {"url": f"https://{host}/search/results/people/?keywords=tyler+chen"}, "ok": True},
        {"tool": "BrowserClickIndex", "input": {"index": 7}, "ok": True,
         "clicked_role": "link", "clicked_name": "Tyler Chen"},
        {"tool": "BrowserClickIndex", "input": {"index": 68}, "ok": True,
         "clicked_role": "button", "clicked_name": "Message"},
        {"tool": "BrowserType", "input": {"selector": "div.msg-form", "text": "hello there r1"}, "ok": True},
        {"tool": "BrowserClickIndex", "input": {"index": 113}, "ok": True,
         "clicked_role": "button", "clicked_name": "Send"},
    ]
    task = "go to tyler chen's linkedin and text him 'hello there r1'"
    assert sk.record_skill(host, task, log)
    return host, task


def test_find_similar_skill_exact_and_variant(p_isolated_skills):
    host, task = p_record_dm_skill()
    s, score = sk.find_similar_skill(host, task)
    assert s is not None and score == 1.0
    # different quoted payload = same sig (slot), still exact
    s2, score2 = sk.find_similar_skill(host, "go to tyler chen's linkedin and text him 'bye now r2'")
    assert s2 is not None and score2 == 1.0
    # reworded but overlapping task clears the threshold
    s3, score3 = sk.find_similar_skill(host, "text tyler chen on linkedin 'yo r3'")
    assert s3 is not None and 0.5 <= score3 < 1.0
    # unrelated task does not
    s4, _ = sk.find_similar_skill(host, "order a pizza from dominos")
    assert s4 is None
    # wrong host never matches
    s5, _ = sk.find_similar_skill("www.reddit.com", task)
    assert s5 is None


def test_find_similar_skill_skips_quarantined(p_isolated_skills):
    host, task = p_record_dm_skill()
    sk.mark_replay_failed(host, task)  # probation -> quarantine
    s, _ = sk.find_similar_skill(host, task)
    assert s is None


def test_render_route_hint_fills_slots_and_flags_send(p_isolated_skills):
    host, task = p_record_dm_skill()
    s, score = sk.find_similar_skill(host, "go to tyler chen's linkedin and text him 'fresh payload r9'")
    hint, keys = sk.render_route_hint(s, "go to tyler chen's linkedin and text him 'fresh payload r9'", score)
    assert "route hint" in hint and len(keys) == 5
    # the live task's payload appears; the recorded one never does
    assert "fresh payload r9" in hint and "hello there r1" not in hint
    assert "IRREVERSIBLE" in hint and "SOLO" in hint
    # the send step is flagged, not the earlier ones
    lines = [l for l in hint.splitlines() if l[:1].isdigit()]
    assert "IRREVERSIBLE" in lines[-1] and "IRREVERSIBLE" not in lines[0]
    # routine prefix invites one batch
    assert "BrowserBatch" in hint


def test_route_hint_adoption_matching(p_isolated_skills):
    host, task = p_record_dm_skill()
    s, score = sk.find_similar_skill(host, task)
    _, keys = sk.render_route_hint(s, task, score)
    run_log = [
        {"tool": "BrowserNavigate", "input": {"url": f"https://{host}/search/results/people/?keywords=tyler+chen&origin=GLOBAL"}, "ok": True},
        {"tool": "BrowserClickIndex", "input": {"index": 3}, "ok": True,
         "clicked_role": "link", "clicked_name": "Tyler Chen Premium 1st"},
        {"tool": "BrowserType", "input": {"selector": "div.msg-form", "text": "x"}, "ok": True},
    ]
    adopted = [sk.hint_step_adopted(k, run_log) for k in keys]
    # navigate (query-stripped match), profile click (containment), type all adopt; the Message and Send clicks did not run
    assert adopted[0] and adopted[1] and adopted[3]
    assert not adopted[2] and not adopted[4]


# --- conservative detour pruning ---------------------------------------------
def test_distill_prunes_abandoned_navigate_detour():
    # wrong profile opened (navigate), abandoned for a search (navigate), then the right profile + the real productive steps. The first navigate is a detour: nothing acted on its page before the next navigate.
    log = [
        {"tool": "BrowserNavigate", "input": {"url": "https://x.com/in/wrong"}, "ok": True},
        {"tool": "BrowserNavigate", "input": {"url": "https://x.com/search?q=tyler"}, "ok": True},
        {"tool": "BrowserClickIndex", "input": {"index": 1}, "ok": True,
         "clicked_role": "link", "clicked_name": "Tyler Chen"},
        {"tool": "BrowserType", "input": {"selector": "#msg", "text": "hi"}, "ok": True},
    ]
    steps = sk.distill_steps(log)
    urls = [s["params"].get("url") for s in steps if s["tool"] == "BrowserNavigate"]
    assert urls == ["https://x.com/search?q=tyler"]  # the abandoned wrong nav dropped
    assert [s["tool"] for s in steps] == ["BrowserNavigate", "BrowserClickByName", "BrowserType"]


def test_distill_keeps_navigate_that_was_acted_on():
    # a navigate followed by a real action on that page is NOT a detour.
    log = [
        {"tool": "BrowserNavigate", "input": {"url": "https://x.com/form"}, "ok": True},
        {"tool": "BrowserType", "input": {"selector": "#q", "text": "hi"}, "ok": True},
        {"tool": "BrowserNavigate", "input": {"url": "https://x.com/results"}, "ok": True},
        {"tool": "BrowserClickIndex", "input": {"index": 2}, "ok": True,
         "clicked_role": "button", "clicked_name": "Go"},
    ]
    steps = sk.distill_steps(log)
    urls = [s["params"].get("url") for s in steps if s["tool"] == "BrowserNavigate"]
    assert urls == ["https://x.com/form", "https://x.com/results"]  # both kept


# --- replay settle-before-click target ---------------------------------------
def test_replay_settle_target_for_click_by_name():
    assert sk.replay_settle_target(
        {"tool": "BrowserClickByName", "params": {"role": "button", "name": "Send"}}) == "Send"
    # other tools have no settle target
    assert sk.replay_settle_target(
        {"tool": "BrowserType", "params": {"selector": "#m", "text": "hi"}}) is None
    assert sk.replay_settle_target(
        {"tool": "BrowserNavigate", "params": {"url": "https://x.com"}}) is None
    # a too-long/blob name is not a useful settle target
    assert sk.replay_settle_target(
        {"tool": "BrowserClickByName", "params": {"name": "x" * 80}}) is None
    assert sk.replay_settle_target(
        {"tool": "BrowserClickByName", "params": {"name": ""}}) is None
