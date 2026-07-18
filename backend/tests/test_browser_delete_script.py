"""BrowserDeleteItem tool logic (the JS is proven live on X; this pins the pure pieces:
the target is embedded safely, and the eval result maps to an honest removed/not-removed)."""
import json

from backend.apps.agents.browser import browser_delete_script as d


def test_flag_default_off(monkeypatch):
    monkeypatch.delenv("OSW_DELETE_SCRIPT", raising=False)
    assert d.delete_tool_enabled() is False
    monkeypatch.setenv("OSW_DELETE_SCRIPT", "1")
    assert d.delete_tool_enabled() is True


def test_expression_embeds_target_json_safe():
    # a target with quotes must not break out of the JS string literal
    tricky = 'he said "hi"; alert(1)'
    expr = d.delete_item_expression(tricky)
    assert json.dumps(tricky) in expr           # embedded as a JSON literal
    assert 'const TARGET = ' + json.dumps(tricky) in expr


def test_parse_removed_true():
    r = d.parse_delete_result({"value": {"stage": "done", "ok": True, "msg": "item removed"}})
    assert r == {"removed": True, "stage": "done", "msg": "item removed"}


def test_parse_removed_false_still_present():
    r = d.parse_delete_result({"value": {"stage": "done", "ok": False, "msg": "still on the page"}})
    assert r["removed"] is False and r["stage"] == "done"


def test_parse_not_on_page():
    r = d.parse_delete_result({"value": {"stage": "find", "ok": False, "msg": "target text not on this page"}})
    assert r["removed"] is False and r["stage"] == "find"


def test_parse_text_wrapped_json():
    r = d.parse_delete_result({"text": json.dumps({"stage": "done", "ok": True, "msg": "item removed"})})
    assert r["removed"] is True


def test_parse_unreadable_is_honest_failure():
    assert d.parse_delete_result({"error": "eval blew up"})["removed"] is False
    assert d.parse_delete_result({"value": "not a dict"})["removed"] is False
    assert d.parse_delete_result("garbage")["removed"] is False
