"""The agent front door for event triggers: WatchForEvent builds validated
trigger configs from NL-shaped args (actionable errors the agent can relay),
attaches to an existing workflow by id-or-title or creates one, validates
mcps against the connected-tool list, and List/Remove round out the loop.

Run:
    cd backend && .venv/bin/python -m pytest tests/test_watch_for_event_tool.py -v
"""

import backend.apps.agents.schedule_mcp_server as srv


def p_patch_call(monkeypatch, workflows=None, tools=None):
    calls = []

    def p_fake_call(method, path, body=None, timeout=30):
        calls.append((method, path, body))
        if path == "/list":
            return {"workflows": workflows or []}
        if path.startswith("http") and path.endswith("/api/tools/list"):
            return {"tools": tools if tools is not None else []}
        if method == "POST" and path == "/create":
            return {"id": "new-wf", "title": (body or {}).get("title")}
        if method == "PATCH":
            return {"id": path.strip("/")}
        return {}

    monkeypatch.setattr(srv, "_call", p_fake_call)
    return calls


def test_kind_validation_gives_actionable_errors(monkeypatch):
    p_patch_call(monkeypatch)
    assert srv.handle_watch_for_event({"kind": "banana"}).get("isError")
    out = srv.handle_watch_for_event({"kind": "file", "workflow": "x"})
    assert out.get("isError") and "path" in out["content"][0]["text"]
    out = srv.handle_watch_for_event({"kind": "agent", "workflow": "x"})
    assert out.get("isError") and "check" in out["content"][0]["text"]


def test_unknown_mcp_name_is_caught_with_the_valid_list(monkeypatch):
    p_patch_call(monkeypatch, tools=[{"id": "google-workspace"}, {"id": "notion"}])
    out = srv.handle_watch_for_event({
        "kind": "agent", "workflow": "x", "check": "new email arrived", "mcps": ["gmial"],
    })
    assert out.get("isError")
    text = out["content"][0]["text"]
    assert "gmial" in text and "google-workspace" in text


def test_attaches_to_existing_workflow_by_title(monkeypatch):
    wfs = [{"id": "w9", "title": "Inbox digest", "event_triggers": [{"id": "old1", "enabled": True, "source": {"kind": "custom"}}]}]
    calls = p_patch_call(monkeypatch, workflows=wfs)
    out = srv.handle_watch_for_event({
        "kind": "agent", "workflow": "inbox digest",
        "check": "an email from the landlord arrived", "mcps": [], "poll_minutes": 10,
    })
    assert not out.get("isError")
    patch = next(c for c in calls if c[0] == "PATCH")
    assert patch[1] == "/w9"
    triggers = patch[2]["event_triggers"]
    assert len(triggers) == 2  # kept the existing one
    assert triggers[1]["source"]["kind"] == "agent"
    assert triggers[1]["source"]["poll_seconds"] == 600


def test_creates_workflow_when_none_named(monkeypatch):
    calls = p_patch_call(monkeypatch)
    out = srv.handle_watch_for_event({
        "kind": "web", "title": "Reservation watch",
        "steps": ["Book a table for two and tell me"],
        "url": "https://example.com/reserve", "watch_for": "a slot opens",
        "only_when": "a weekend slot",
    })
    assert not out.get("isError")
    create = next(c for c in calls if c[1] == "/create")
    body = create[2]
    assert body["schedule"] == {"enabled": False}
    trig = body["event_triggers"][0]
    assert trig["source"]["url"] == "https://example.com/reserve"
    assert trig["predicate"] == "a weekend slot"

    # Creating with no steps and no workflow is a guided error, not a mystery.
    out = srv.handle_watch_for_event({"kind": "web", "url": "https://x.com"})
    assert out.get("isError") and "steps" in out["content"][0]["text"]


def test_custom_kind_returns_the_ingest_endpoint(monkeypatch):
    p_patch_call(monkeypatch)
    out = srv.handle_watch_for_event({"kind": "custom", "title": "Stripe events", "steps": ["Summarize the event"]})
    assert not out.get("isError")
    assert "/api/events/ingest" in out["content"][0]["text"]


def test_list_and_remove_round_trip(monkeypatch):
    wfs = [{
        "id": "w1", "title": "Watchers",
        "event_triggers": [
            {"id": "t1", "enabled": True, "source": {"kind": "file", "path": "~/Downloads"}, "predicate": ""},
            {"id": "t2", "enabled": False, "source": {"kind": "web", "url": "https://a.b", "watch_for": "x"}, "predicate": "only big"},
        ],
    }]
    calls = p_patch_call(monkeypatch, workflows=wfs)
    listed = srv.handle_list_event_triggers({})
    text = listed["content"][0]["text"]
    assert "~/Downloads" in text and "t2" in text and "only big" in text

    out = srv.handle_remove_event_trigger({"workflow": "Watchers", "trigger_id": "t1"})
    assert not out.get("isError")
    patch = next(c for c in calls if c[0] == "PATCH")
    assert [t["id"] for t in patch[2]["event_triggers"]] == ["t2"]

    out = srv.handle_remove_event_trigger({"workflow": "Watchers", "trigger_id": "ghost"})
    assert out.get("isError") and "t1" in out["content"][0]["text"]
