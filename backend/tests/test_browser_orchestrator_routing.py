"""The orchestrator's browser-delegation guidance.

BrowserRepeatFlow lives in the browser SUB-agent, but the orchestrator decides
HOW to delegate. If it splits a 'same flow, many items' task into N parallel
sub-agents, each gets one item and RepeatFlow is never reachable. This pins the
guidance that routes such tasks to ONE sub-agent with the whole list, so the
batch path is actually usable (not stranded behind the delegation layer).
"""

import types

from backend.apps.agents.manager.prompt import prompt_context as pc


def p_fake_dashboard(monkeypatch):
    # build_browser_context loads the dashboard; give it a minimal one so it gets past the load and emits the static delegation guidance.
    import backend.apps.dashboards.dashboards as dash

    class P_D:
        def model_dump(self, mode="json"):
            return {"layout": {"browser_cards": {}}}
    monkeypatch.setattr(dash, "load", lambda did: P_D(), raising=True)


def test_orchestrator_routes_same_flow_batches_to_one_agent(monkeypatch):
    p_fake_dashboard(monkeypatch)
    ctx = pc.build_browser_context("dash-1", selected_browser_ids=[])
    assert ctx is not None
    # the key guidance: one agent + the whole list, not one agent per item
    assert "Give ONE agent the whole list" in ctx
    assert "BrowserRepeatFlow" in ctx
    # and it explicitly steers AWAY from the per-item parallel split for same flows
    assert "only for genuinely DIFFERENT tasks" in ctx


def test_browser_context_is_none_without_a_dashboard():
    assert pc.build_browser_context(None) is None
