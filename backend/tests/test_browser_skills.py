"""Browser skill cache: task normalization, robust distillation, record/find."""

import pytest

from backend.apps.agents.browser import browser_skills as sk


@pytest.fixture(autouse=True)
def _clear():
    sk.clear()
    yield
    sk.clear()


def test_normalize_task_is_stable_across_rewordings():
    a = sk.normalize_task('Go to http://x.com/form and type "hi" into the box, then click Send.')
    b = sk.normalize_task('type "hi" into the box click Send')
    # urls, punctuation, and filler words drop out; core tokens remain
    assert "send" in a and "type" in a and "http" not in a
    assert a == b


def test_host_of():
    assert sk.host_of("http://localhost:8901/form.html") == "localhost:8901"
    assert sk.host_of("https://docs.google.com/x") == "docs.google.com"


def _log():
    return [
        {"tool": "BrowserScreenshot", "input": {}, "ok": False},
        {"tool": "BrowserNavigate", "input": {"url": "http://h/form"}, "ok": True},
        {"tool": "BrowserType", "input": {"selector": "#msg", "text": "hello world"}, "ok": True},
        {"tool": "BrowserGetText", "input": {}, "ok": True},
        {"tool": "BrowserClickIndex", "input": {"index": 3}, "ok": True,
         "clicked_role": "button", "clicked_name": "Send"},
    ]


def test_distill_builds_robust_steps():
    steps = sk.distill_steps(_log())
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
    # the agent's efficient path bundles type+press_key into one BrowserBatch;
    # the recorder must flatten those into discrete robust steps.
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
    assert sk.record_skill("localhost:8901", "type hello and click Send", _log()) is True
    found = sk.find_skill("localhost:8901", "Please type hello and click Send")
    assert found is not None
    assert [s["tool"] for s in found["steps"]] == ["BrowserNavigate", "BrowserType", "BrowserClickByName"]


def test_find_is_host_scoped():
    sk.record_skill("a.com", "do thing now", _log())
    assert sk.find_skill("b.com", "do thing now") is None


def test_record_refuses_unrecordable_run():
    # navigate-only -> nothing stored
    assert sk.record_skill("h", "just go", [{"tool": "BrowserNavigate", "input": {"url": "http://h/"}, "ok": True}]) is False
    assert sk.find_skill("h", "just go") is None
