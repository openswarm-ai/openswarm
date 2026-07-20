"""The InvokeWorkflow MCP tool: resolves id-or-title among EXPOSED workflows only,
lists the invocable set on a miss, and relays the backend's run result."""
import backend.apps.agents.schedule_mcp_server as srv


def p_patch_call(monkeypatch, workflows, invoke_result=None):
    calls = []

    def p_fake_call(method, path, body=None, timeout=30):
        calls.append((method, path))
        if path == "/list":
            return {"workflows": workflows}
        if path.endswith("/invoke"):
            return invoke_result or {}
        return {}

    monkeypatch.setattr(srv, "_call", p_fake_call)
    return calls


def test_resolves_exact_title_among_exposed_only(monkeypatch):
    wfs = [
        {"id": "w1", "title": "Daily brief", "exposed_as_tool": True},
        {"id": "w2", "title": "Secret ops", "exposed_as_tool": False},
    ]
    calls = p_patch_call(monkeypatch, wfs, {"status": "success", "error": None, "transcript": "did it", "timed_out": False})
    out = srv.handle_invoke_workflow({"workflow": "daily brief"})
    assert not out.get("isError")
    text = out["content"][0]["text"]
    assert "success" in text and "did it" in text
    assert ("POST", "/w1/invoke") in calls


def test_unexposed_workflow_is_not_invocable(monkeypatch):
    wfs = [{"id": "w2", "title": "Secret ops", "exposed_as_tool": False}]
    p_patch_call(monkeypatch, wfs)
    out = srv.handle_invoke_workflow({"workflow": "Secret ops"})
    assert out.get("isError")


def test_miss_lists_the_invocable_set(monkeypatch):
    wfs = [{"id": "w1", "title": "Daily brief", "exposed_as_tool": True}]
    p_patch_call(monkeypatch, wfs)
    out = srv.handle_invoke_workflow({"workflow": "nope"})
    assert out.get("isError")
    assert "Daily brief" in out["content"][0]["text"]


def test_timeout_reports_background_continuation(monkeypatch):
    wfs = [{"id": "w1", "title": "Daily brief", "exposed_as_tool": True}]
    p_patch_call(monkeypatch, wfs, {"timed_out": True})
    out = srv.handle_invoke_workflow({"workflow": "w1"})
    assert not out.get("isError")
    assert "History" in out["content"][0]["text"]


def test_tool_is_declared_and_dispatchable():
    assert any(t["name"] == "InvokeWorkflow" for t in srv.TOOLS)
    assert srv.HANDLERS["InvokeWorkflow"] is srv.handle_invoke_workflow
