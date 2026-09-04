"""The Usage page's by-lane counts come from 9router's stats, whose counter is named `requests`;
the summary read `count` and showed 0 requests on every lane (2026-09-04, found while proving which
credential served Chuya's chat)."""

import asyncio

from backend.apps.service import service


def test_by_lane_requests_read_the_routers_requests_counter(monkeypatch):
    stats = {
        "totalRequests": 7, "totalPromptTokens": 100, "totalCompletionTokens": 50, "totalCost": 0.5,
        "byModel": {"claude-sonnet-5 (claude)": {"requests": 5, "cost": 0.4, "promptTokens": 80, "completionTokens": 40}},
        "byProvider": {"claude": {"requests": 7, "cost": 0.5}},
    }
    import backend.apps.nine_router as nr
    async def fake_stats(period="all"):
        return stats
    monkeypatch.setattr(nr, "get_usage_stats", fake_stats)
    monkeypatch.setattr(nr, "is_running", lambda: True)
    monkeypatch.setattr(service, "load_sessions_for_usage", lambda *a, **k: [], raising=False)
    out = asyncio.run(service.usage_summary(window="30d"))
    assert out["cost_by_provider"]["claude"]["requests"] == 7
    assert out["cost_by_model"]["claude-sonnet-5 (claude)"]["requests"] == 5
