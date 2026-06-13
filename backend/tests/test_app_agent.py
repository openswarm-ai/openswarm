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
    desc = BA._app_bridge_expression("AppDescribe", {})
    assert "window.OPENSWARM_APP.describe()" in desc
    assert "JSON.stringify" in desc  # round-trips as text
    state = BA._app_bridge_expression("AppGetState", {})
    assert "window.OPENSWARM_APP.getState()" in state


def test_app_bridge_expression_invoke_serializes_args():
    expr = BA._app_bridge_expression("AppInvoke", {"name": "addExpr", "args": {"latex": "y=x^2"}})
    # name + args are JSON-encoded into the call
    assert 'window.OPENSWARM_APP.invoke("addExpr", {"latex": "y=x^2"})' in expr
    # missing bridge is handled inside the expression, never throws
    assert "typeof A.describe!=='function'" in expr


def test_app_bridge_expression_invoke_defaults_args_to_empty_object():
    expr = BA._app_bridge_expression("AppInvoke", {"name": "clear"})
    assert 'window.OPENSWARM_APP.invoke("clear", {})' in expr


# --- execute_browser_tool routing -------------------------------------------
def test_execute_browser_tool_app_bridge_routes_to_evaluate(monkeypatch):
    captured = {}

    async def _send(request_id, action, browser_id, params, tab_id=""):
        captured.update(action=action, browser_id=browser_id, params=params)
        return {"text": json.dumps([{"name": "addExpr"}])}

    monkeypatch.setattr(BA.ws_manager, "send_browser_command", _send, raising=False)
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

    async def _fake_run_browser_agent(**kwargs):
        recorded.update(kwargs)
        return {"summary": "done", "action_log": [], "final_screenshot": None}

    async def _boom(*a, **k):
        raise AssertionError("app mode must not create a browser card")

    monkeypatch.setattr(BA, "run_browser_agent", _fake_run_browser_agent, raising=True)
    monkeypatch.setattr(BA, "_create_browser_card", _boom, raising=True)
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
def _load_mcp_server(monkeypatch, selected):
    import backend.apps.agents.browser_agent_mcp_server as srv
    monkeypatch.setattr(srv, "SELECTED_APP_IDS", list(selected), raising=False)
    return srv


def test_app_agent_tool_builds_app_task(monkeypatch):
    srv = _load_mcp_server(monkeypatch, ["abc"])
    captured = {}

    def _call_backend(tasks):
        captured["tasks"] = tasks
        return {"results": [{"summary": "graphed it", "action_log": []}]}

    monkeypatch.setattr(srv, "call_backend", _call_backend, raising=True)
    res = srv.handle_tool_call("AppAgent", {"output_id": "abc", "task": "graph y=x^2"})

    assert not res.get("isError")
    task_def = captured["tasks"][0]
    assert task_def["browser_id"] == "app:abc"
    assert task_def["app_mode"] is True
    assert task_def["task"] == "graph y=x^2"


def test_app_agent_tool_rejects_unselected_app(monkeypatch):
    srv = _load_mcp_server(monkeypatch, ["abc"])

    def _call_backend(tasks):
        raise AssertionError("must not dispatch an unselected app")

    monkeypatch.setattr(srv, "call_backend", _call_backend, raising=True)
    res = srv.handle_tool_call("AppAgent", {"output_id": "zzz", "task": "graph"})
    assert res.get("isError")
    assert "not a selected app" in res["content"][0]["text"]


def test_app_agent_tool_requires_output_id(monkeypatch):
    srv = _load_mcp_server(monkeypatch, [])
    res = srv.handle_tool_call("AppAgent", {"task": "graph"})
    assert res.get("isError")
    assert "output_id is required" in res["content"][0]["text"]


# --- orchestrator context advertises AppAgent --------------------------------
def test_selected_app_context_advertises_app_agent(monkeypatch):
    import os
    from backend.apps.agents.manager.prompt import prompt_context as pc
    import backend.apps.outputs.workspace_io as wio

    class _Out:
        workspace_id = "ws-1"
        name = "Grapher"

    monkeypatch.setattr(wio, "load_output", lambda oid: _Out(), raising=True)
    monkeypatch.setattr(os.path, "isdir", lambda p: True, raising=True)
    monkeypatch.setattr(os.path, "isfile", lambda p: False, raising=True)

    ctx = pc._build_selected_app_context(["abc"])
    assert ctx is not None
    assert "App id (for AppAgent): abc" in ctx
    assert "AppAgent(output_id, task)" in ctx
