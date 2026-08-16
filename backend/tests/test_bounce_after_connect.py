"""A freshly connected subscription must not stay dead until an app restart (ENG-315).

Live evidence on packaged exp.9: with the router knowing the sub and the app booted without it,
picker payload, fresh GPT session, and a pre-connect session switched to GPT all worked with zero
restart, so every layer we own reads live. The remaining stale layer is the router process itself
(0.3.60 stamps modelLock cooldowns + testStatus into its in-memory DB and skips locked connections
at dispatch), and a router restart was the measured heal. These pin that connect-success actually
schedules that heal, sequentially, and that a failed bounce cannot take the poll route down.
"""
import asyncio
import inspect

import pytest

from backend.apps.nine_router import bounce_after_connect as b


@pytest.mark.asyncio
async def test_bounce_is_sequential_stop_then_start(monkeypatch):
    order = []
    monkeypatch.setattr(b.p_router, "stop", lambda: order.append("stop"))

    async def p_start():
        order.append("start")
    monkeypatch.setattr(b.p_router, "ensure_running", p_start)
    monkeypatch.setattr(b.p_router, "is_running", lambda: True)
    assert await b.bounce_router_after_connect("codex") is True
    assert order == ["stop", "start"], "two live routers once rotated a token family to death; stop must fully precede start"


@pytest.mark.asyncio
async def test_a_failed_bounce_never_raises(monkeypatch):
    def p_boom():
        raise RuntimeError("router dir vanished")
    monkeypatch.setattr(b.p_router, "stop", p_boom)
    assert await b.bounce_router_after_connect("codex") is False


def test_poll_success_schedules_the_bounce():
    # Wire-check both directions: the heal exists AND the connect chokepoint calls it (ENG-284 rule).
    from backend.apps.agents import agents as agents_mod
    src = inspect.getsource(agents_mod)
    poll = src[src.index("async def subscriptions_poll"):src.index("async def subscriptions_exchange")]
    assert "bounce_router_after_connect" in poll, "an unheal-ed connect is the whole ENG-315 bug"
    assert 'result.get("success")' in poll.split("bounce_router_after_connect")[0], "the bounce must be gated on OAuth success, never on every poll tick"
    assert "create_task" in poll, "the UI's Connected flash must not wait ~10s on the bounce"
