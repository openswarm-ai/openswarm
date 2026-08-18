"""ENG-338: a browser run whose sidecar caller died must be cancelled, not orphaned.

The first fix polled request.is_disconnected(), and the packaged drill proved that NEVER fires on
real uvicorn when the sidecar half-closes (the run kept driving 40s after the sever). The seal is
now a heartbeat STREAM: a write to the dead socket fails, the generator is closed, and its finally
cancels the run. These tests drive the generator directly, both directions."""
import asyncio

import pytest

from backend.main import browser_agent_run


class P_Req:
    async def json(self):
        return {"tasks": [{"task": "look at example.com"}], "parent_session_id": "s1"}


@pytest.mark.asyncio
async def test_closing_the_stream_mid_run_cancels_the_run(monkeypatch):
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
    resp = await browser_agent_run(P_Req())
    gen = resp.body_iterator
    first = await gen.__anext__()
    assert first == b" ", "pending run must heartbeat whitespace"
    # The dead-socket path: uvicorn closes the generator when a write fails.
    await gen.aclose()
    assert state["started"] is True
    assert state["cancelled"] is True, "the orphaned run must be cancelled, not left driving the card"


@pytest.mark.asyncio
async def test_a_live_caller_gets_the_results_as_valid_json(monkeypatch):
    async def p_quick(**p_kw):
        await asyncio.sleep(0)
        return [{"summary": "done"}]

    import json

    import backend.apps.agents.browser.browser_agent as p_ba
    monkeypatch.setattr(p_ba, "run_browser_agents", p_quick)
    resp = await browser_agent_run(P_Req())
    chunks = []
    async for c in resp.body_iterator:
        chunks.append(c)
    body = b"".join(chunks)
    parsed = json.loads(body)
    assert parsed["results"][0]["summary"] == "done"
