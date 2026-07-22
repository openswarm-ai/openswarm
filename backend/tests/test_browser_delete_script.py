"""BrowserDeleteItem tool logic (the resolve JS is proven live; this pins the pure pieces and
the resolve->trusted-click->verify orchestration with a mocked tool runner)."""
import json

import pytest

from backend.apps.agents.browser import browser_delete_script as d


def test_flag_default_off(monkeypatch):
    monkeypatch.delenv("OSW_DELETE_SCRIPT", raising=False)
    assert d.delete_tool_enabled() is False
    monkeypatch.setenv("OSW_DELETE_SCRIPT", "1")
    assert d.delete_tool_enabled() is True


def test_expression_embeds_target_json_safe():
    # a target with quotes must not break out of the JS string literal
    tricky = 'he said "hi"; alert(1)'
    expr = d.resolve_expression("more", tricky)
    assert json.dumps(tricky) in expr           # embedded as a JSON literal
    assert 'const TARGET = ' + json.dumps(tricky) in expr
    assert "const STEP = \"more\"" in expr


def make_exec(step_results, click_ok=True, verify_after_refresh=None):
    """Tool-runner mock: BrowserEvaluate returns the scripted resolve result for the step it was
    called with (read out of the expression); BrowserClickPoint records real-input clicks; the
    location probe and BrowserNavigate model the refresh-reverify pass."""
    calls = {"clicks": [], "steps": [], "navs": []}

    async def execute(tool, params, bid, tid):
        if tool == "BrowserEvaluate":
            expr = params["expression"]
            if "location.href" in expr:
                return {"value": {"href": "https://site.test/profile"}}
            step = expr.split('const STEP = "', 1)[1].split('"', 1)[0]
            calls["steps"].append(step)
            if step == "verify" and calls["navs"] and verify_after_refresh is not None:
                return {"value": verify_after_refresh}
            return {"value": step_results[step]}
        if tool == "BrowserClickPoint":
            calls["clicks"].append((params["xPercent"], params["yPercent"]))
            return {"ok": True} if click_ok else {"error": "no webview"}
        if tool == "BrowserNavigate":
            calls["navs"].append(params["url"])
            return {"ok": True}
        return {"ok": True}
    return execute, calls


POS = {"xPct": 50.0, "yPct": 40.0}


@pytest.mark.asyncio
async def test_full_flow_clicks_each_stage_with_real_input():
    ex, calls = make_exec({
        "more": {"ok": True, "stage": "more", **POS},
        "menuitem": {"ok": True, "stage": "menuitem", **POS},
        "confirm": {"ok": True, "stage": "confirm", **POS},
        "verify": {"ok": True, "stage": "verify"},
    })
    r = await d.run_delete("coffee notes abc123", "b1", "", ex)
    assert r == {"removed": True, "stage": "done", "msg": "item removed"}
    assert len(calls["clicks"]) == 3            # more, menuitem, confirm: all real-input clicks
    assert calls["steps"][-1] == "verify"


@pytest.mark.asyncio
async def test_verify_still_present_is_honest():
    # still-present survives the refresh re-verify too: honest not-removed, one refresh attempted
    ex, calls = make_exec({
        "more": {"ok": True, "stage": "more", **POS},
        "menuitem": {"ok": True, "stage": "menuitem", **POS},
        "confirm": {"ok": True, "stage": "confirm", **POS},
        "verify": {"ok": False, "stage": "verify"},
    })
    r = await d.run_delete("coffee notes abc123", "b1", "", ex)
    assert r["removed"] is False and r["stage"] == "done"
    assert calls["navs"] == ["https://site.test/profile"]


@pytest.mark.asyncio
async def test_stale_tile_flips_removed_after_refresh():
    """Shreddit keeps the dead tile mounted until a reload; the refresh re-verify turns a real
    server-side delete into removed=True instead of an honest-but-wrong still-present."""
    ex, calls = make_exec({
        "more": {"ok": True, "stage": "more", **POS},
        "menuitem": {"ok": True, "stage": "menuitem", **POS},
        "confirm": {"ok": True, "stage": "confirm", **POS},
        "verify": {"ok": False, "stage": "verify"},
    }, verify_after_refresh={"ok": True, "stage": "verify"})
    r = await d.run_delete("coffee notes abc123", "b1", "", ex)
    assert r["removed"] is True
    assert len(calls["navs"]) == 1


@pytest.mark.asyncio
async def test_missing_confirm_is_optional_verify_decides():
    ex, calls = make_exec({
        "more": {"ok": True, "stage": "more", **POS},
        "menuitem": {"ok": True, "stage": "menuitem", **POS},
        "confirm": {"ok": False, "stage": "confirm", "optional": True, "msg": "no confirm dialog appeared"},
        "verify": {"ok": True, "stage": "verify"},
    })
    r = await d.run_delete("coffee notes abc123", "b1", "", ex)
    assert r["removed"] is True
    assert len(calls["clicks"]) == 2            # confirm never clicked


@pytest.mark.asyncio
async def test_stage_failure_reports_stage_and_never_removed():
    ex, calls = make_exec({
        "more": {"ok": False, "stage": "find", "msg": "target text not on this page"},
    })
    r = await d.run_delete("coffee notes abc123", "b1", "", ex)
    assert r == {"removed": False, "stage": "find", "msg": "target text not on this page"}
    assert not calls["clicks"]


@pytest.mark.asyncio
async def test_unreadable_resolve_is_honest_failure():
    async def execute(tool, params, bid, tid):
        return {"error": "eval blew up"}
    r = await d.run_delete("coffee notes abc123", "b1", "", execute)
    assert r["removed"] is False and r["stage"] == "eval"
