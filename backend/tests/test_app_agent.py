"""App agent: driving an OpenSwarm-built app through its window.OPENSWARM_APP bridge.

Pins the wiring that makes an app drivable without touching a real webview or LLM:
  - the three App bridge tools translate to a single BrowserEvaluate against the
    app's bridge,
  - run_browser_agents forwards app_mode + the "app:<id>" target without creating
    or navigating a browser card,
  - the AppAgent delegation tool builds the right task and gates on the user's
    selected apps,
  - the orchestrator's selected-app context advertises AppAgent.
"""

import asyncio
import json

from backend.apps.agents.browser import browser_agent as BA


# --- bridge expression -------------------------------------------------------
def test_app_bridge_expression_describe_and_state():
    desc = BA.app_bridge_expression("AppDescribe", {})
    assert "window.OPENSWARM_APP.describe()" in desc
    assert "JSON.stringify" in desc  # round-trips as text
    state = BA.app_bridge_expression("AppGetState", {})
    assert "window.OPENSWARM_APP.getState()" in state


def test_app_bridge_expression_invoke_serializes_args():
    expr = BA.app_bridge_expression("AppInvoke", {"name": "addExpr", "args": {"latex": "y=x^2"}})
    # name + args are JSON-encoded into the call
    assert 'window.OPENSWARM_APP.invoke("addExpr", {"latex": "y=x^2"})' in expr
    # missing bridge is handled inside the expression, never throws
    assert "typeof A.describe!=='function'" in expr


def test_app_bridge_expression_invoke_defaults_args_to_empty_object():
    expr = BA.app_bridge_expression("AppInvoke", {"name": "clear"})
    assert 'window.OPENSWARM_APP.invoke("clear", {})' in expr


# --- execute_browser_tool routing -------------------------------------------
def test_execute_browser_tool_app_bridge_routes_to_evaluate(monkeypatch):
    captured = {}

    async def p_send(request_id, action, browser_id, params, tab_id=""):
        captured.update(action=action, browser_id=browser_id, params=params)
        return {"text": json.dumps([{"name": "addExpr"}])}

    monkeypatch.setattr(BA.ws_manager, "send_browser_command", p_send, raising=False)
    out = asyncio.run(BA.execute_browser_tool(
        "AppInvoke", {"name": "addExpr", "args": {"latex": "y=x^2"}}, "app:abc",
    ))
    assert captured["action"] == "evaluate"
    assert captured["browser_id"] == "app:abc"
    assert "window.OPENSWARM_APP.invoke" in captured["params"]["expression"]
    assert out["text"]  # result passes straight through


# --- run_browser_agents app_mode wiring -------------------------------------
def test_run_browser_agents_app_mode_forwards_flag_no_card(monkeypatch):
    recorded = {}

    async def p_fake_run_browser_agent(**kwargs):
        recorded.update(kwargs)
        return {"summary": "done", "action_log": [], "final_screenshot": None}

    async def p_boom(*a, **k):
        raise AssertionError("app mode must not create a browser card")

    monkeypatch.setattr(BA, "run_browser_agent", p_fake_run_browser_agent, raising=True)
    monkeypatch.setattr(BA, "p_create_browser_card", p_boom, raising=True)
    # a connected dashboard so dispatch isn't refused
    monkeypatch.setattr(BA.ws_manager, "global_connections", [object()], raising=False)

    results = asyncio.run(BA.run_browser_agents(
        tasks=[{"task": "graph y=x^2", "browser_id": "app:abc", "app_mode": True}],
        model="sonnet",
        dashboard_id="dash-1",
    ))

    assert results and results[0]["summary"] == "done"
    assert recorded["app_mode"] is True
    assert recorded["browser_id"] == "app:abc"
    assert recorded["initial_url"] is None  # app already loaded; never navigate


# --- AppAgent delegation tool -----------------------------------------------
def p_load_mcp_server(monkeypatch, selected):
    import backend.apps.agents.browser_agent_mcp_server as srv
    monkeypatch.setattr(srv, "SELECTED_APP_IDS", list(selected), raising=False)
    return srv


def test_app_agent_tool_builds_app_task(monkeypatch):
    srv = p_load_mcp_server(monkeypatch, ["abc"])
    captured = {}

    def p_call_backend(tasks):
        captured["tasks"] = tasks
        return {"results": [{"summary": "graphed it", "action_log": []}]}

    monkeypatch.setattr(srv, "call_backend", p_call_backend, raising=True)
    res = srv.handle_tool_call("AppAgent", {"output_id": "abc", "task": "graph y=x^2"})

    assert not res.get("isError")
    task_def = captured["tasks"][0]
    assert task_def["browser_id"] == "app:abc"
    assert task_def["app_mode"] is True
    assert task_def["task"] == "graph y=x^2"


def test_app_agent_tool_rejects_unselected_app(monkeypatch):
    srv = p_load_mcp_server(monkeypatch, ["abc"])

    def p_call_backend(tasks):
        raise AssertionError("must not dispatch an unselected app")

    monkeypatch.setattr(srv, "call_backend", p_call_backend, raising=True)
    res = srv.handle_tool_call("AppAgent", {"output_id": "zzz", "task": "graph"})
    assert res.get("isError")
    assert "not a selected app" in res["content"][0]["text"]


def test_app_agent_tool_requires_output_id(monkeypatch):
    srv = p_load_mcp_server(monkeypatch, [])
    res = srv.handle_tool_call("AppAgent", {"task": "graph"})
    assert res.get("isError")
    assert "output_id is required" in res["content"][0]["text"]


# --- orchestrator context advertises AppAgent --------------------------------
def test_selected_app_context_advertises_app_agent(monkeypatch):
    import os
    from backend.apps.agents.manager.prompt import prompt_context as pc
    import backend.apps.outputs.workspace_io as wio

    class POut:
        workspace_id = "ws-1"
        name = "Grapher"

    monkeypatch.setattr(wio, "load_output", lambda oid: POut(), raising=True)
    monkeypatch.setattr(os.path, "isdir", lambda p: True, raising=True)
    monkeypatch.setattr(os.path, "isfile", lambda p: False, raising=True)

    ctx = pc.build_selected_app_context(["abc"])
    assert ctx is not None
    assert "App id (for AppAgent): abc" in ctx
    assert "AppAgent(output_id, task)" in ctx


# --- bridge readiness + parsing ---------------------------------------------
def test_parse_bridge_result_decodes_json_text():
    assert BA.parse_bridge_result({"text": json.dumps([{"name": "x"}])}) == [{"name": "x"}]
    assert BA.parse_bridge_result({"text": "null"}) is None
    assert BA.parse_bridge_result({"error": "boom"}) is None
    assert BA.parse_bridge_result({"text": "not json"}) is None
    assert BA.parse_bridge_result({}) is None


def test_bridge_ready_distinguishes_stub_from_registered():
    assert BA.bridge_ready([{"name": "x"}]) is True            # legacy array
    assert BA.bridge_ready({"controls": [], "__rev": 1}) is True
    assert BA.bridge_ready({"__ready": False, "__rev": 0}) is False  # template stub
    assert BA.bridge_ready({"__error__": "threw"}) is False
    assert BA.bridge_ready(None) is False


def test_render_app_controls_array_and_object_forms():
    # Legacy array form: no rules, controls rendered.
    rules_md, controls_md = BA.render_app_controls([{"name": "clear", "description": "wipe"}])
    assert rules_md == ""
    assert "- `clear`: wipe" in controls_md

    # New object form: rules + keys + args rendered.
    rules_md, controls_md = BA.render_app_controls({
        "rules": "Flappy Bird. Keep the bird airborne.",
        "controls": [{"name": "flap", "keys": "Space = flap", "args": {"force": "number"}, "description": "Flap once"}],
        "__rev": 3,
    })
    assert "Flappy Bird" in rules_md
    assert "- `flap`" in controls_md
    assert "[Space = flap]" in controls_md
    assert '"force"' in controls_md

    # Not-ready / absent bridge yields nothing to render.
    assert BA.render_app_controls({"__ready": False}) is None
    assert BA.render_app_controls(None) is None


# --- AppDescribe waits for a still-booting bridge ----------------------------
def test_app_describe_polls_until_bridge_ready(monkeypatch):
    calls = {"n": 0}
    ready = {"rules": "r", "controls": [{"name": "x"}], "__rev": 1}

    async def p_send(request_id, action, browser_id, params, tab_id=""):
        calls["n"] += 1
        if calls["n"] < 3:
            return {"text": json.dumps({"__ready": False, "__rev": 0})}
        return {"text": json.dumps(ready)}

    async def p_no_sleep(p_s):
        return None

    monkeypatch.setattr(BA.ws_manager, "send_browser_command", p_send, raising=False)
    monkeypatch.setattr(BA.asyncio, "sleep", p_no_sleep, raising=True)
    monkeypatch.setattr(BA, "p_persist_app_controls", lambda *a, **k: None, raising=True)

    out = asyncio.run(BA.execute_browser_tool("AppDescribe", {}, "app:abc"))
    assert calls["n"] == 3  # polled twice, succeeded on the third
    assert BA.parse_bridge_result(out) == ready


def test_app_invoke_does_not_poll(monkeypatch):
    calls = {"n": 0}

    async def p_send(request_id, action, browser_id, params, tab_id=""):
        calls["n"] += 1
        return {"text": json.dumps({"__ready": False})}  # would loop forever if AppInvoke waited

    async def p_no_sleep(p_s):
        return None

    monkeypatch.setattr(BA.ws_manager, "send_browser_command", p_send, raising=False)
    monkeypatch.setattr(BA.asyncio, "sleep", p_no_sleep, raising=True)

    asyncio.run(BA.execute_browser_tool("AppInvoke", {"name": "flap"}, "app:abc"))
    assert calls["n"] == 1  # single shot, no readiness wait


def test_app_describe_persists_controls_cache(monkeypatch, tmp_path):
    ready = {"rules": "Keep the bird airborne.", "controls": [{"name": "flap", "keys": "Space"}], "__rev": 1}

    async def p_send(request_id, action, browser_id, params, tab_id=""):
        return {"text": json.dumps(ready)}

    monkeypatch.setattr(BA.ws_manager, "send_browser_command", p_send, raising=False)
    monkeypatch.setattr(BA, "p_app_workspace_dir", lambda bid: str(tmp_path), raising=True)

    asyncio.run(BA.execute_browser_tool("AppDescribe", {}, "app:abc"))
    controls = (tmp_path / ".openswarm" / "controls.md").read_text()
    rules = (tmp_path / ".openswarm" / "rules.md").read_text()
    assert "- `flap`" in controls and "[Space]" in controls
    assert "Keep the bird airborne." in rules
