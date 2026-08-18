"""ENG-338: a browser run whose sidecar caller died must be cancelled, not orphaned.

The MCP disconnects themselves are fixed (ENG-303/327), but WHEN one happens the backend used to
keep driving the browser card with a result nobody could ever read, while the parent's stage-3
recovery re-dispatched onto the same card: two drivers, one wedged browser. The route now watches
its own client and aborts the run the moment the caller is gone."""
import asyncio

import pytest

from backend.main import browser_agent_run


class P_DeadCallerRequest:
    """Request stub: valid body, but the client is already gone."""

    def __init__(self):
        self.disconnect_polls = 0

    async def json(self):
        return {"tasks": [{"task": "look at example.com"}], "parent_session_id": "s1"}

    async def is_disconnected(self):
        self.disconnect_polls += 1
        return True


@pytest.mark.asyncio
async def test_a_dead_caller_cancels_the_run_instead_of_orphaning_it(monkeypatch):
    state = {"cancelled": False, "started": False}

    async def p_never_ending(**p_kw):
        state["started"] = True
        try:
            await asyncio.sleep(3600)
        except asyncio.CancelledError:
            state["cancelled"] = True
            raise

    import backend.apps.agents.browser.browser_agent as p_ba
    monkeypatch.setattr(p_ba, "run_browser_agents", p_never_ending)
    req = P_DeadCallerRequest()
    resp = await browser_agent_run(req)
    assert resp.status_code == 499
    assert state["started"] is True
    assert state["cancelled"] is True, "the orphaned run must be cancelled, not left driving the card"
    assert req.disconnect_polls >= 1


@pytest.mark.asyncio
async def test_a_live_caller_gets_the_results_untouched(monkeypatch):
    async def p_quick(**p_kw):
        return [{"summary": "done"}]

    class P_LiveRequest(P_DeadCallerRequest):
        async def is_disconnected(self):
            return False

    import backend.apps.agents.browser.browser_agent as p_ba
    monkeypatch.setattr(p_ba, "run_browser_agents", p_quick)
    resp = await browser_agent_run(P_LiveRequest())
    assert resp.status_code == 200
    assert b"done" in resp.body
