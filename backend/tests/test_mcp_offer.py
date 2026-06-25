"""Gate-safety invariants for the Phase 2 in-task connect offer (offer_for_gated_server).

The whole point of the offer is that it can ONLY ever suggest, never grant: it must surface a
vetted, inactive, not-dismissed MCP for the user to one-click-connect, and it must never carry
anything that could widen the MCP surface on its own. These tests make a bad offer state fail
loudly instead of shipping a silent gate bypass.
"""

import asyncio
from types import SimpleNamespace

import backend.apps.agents.core.mcp_preflight as pf
from backend.apps.agents.core.mcp_preflight import (
    CURATED_SHORTLIST,
    offer_for_gated_server,
    run_preflight,
)

VETTED = {e["id"] for e in CURATED_SHORTLIST}
OFFER_SHAPE = {"id", "title", "description", "reason"}


def p_settings(dismissed=None):
    return SimpleNamespace(dismissed_mcp_suggestions=dismissed or {})


def test_offer_resolves_both_display_name_and_hotpath_slug(monkeypatch):
    # The hot-path passes a sanitized slug ("google-workspace"); the curated id is a display name ("Google Workspace"). Both must resolve, so the wiring isn't a load-bearing string.
    monkeypatch.setattr(pf, "load_all_tools", lambda: [])  # nothing enabled
    s = p_settings()
    for name in ("Google Workspace", "google-workspace"):
        o = offer_for_gated_server(name, s)
        assert o is not None, f"{name!r} should resolve to the vetted entry"
        assert o["id"] == "Google Workspace"
        assert o["id"] in VETTED


def test_offer_rejects_unvetted_and_empty(monkeypatch):
    monkeypatch.setattr(pf, "load_all_tools", lambda: [])
    s = p_settings()
    assert offer_for_gated_server("NotAVettedServer", s) is None
    assert offer_for_gated_server("", s) is None
    assert offer_for_gated_server(None, s) is None  # type: ignore[arg-type]


def test_offer_suppressed_when_dismissed(monkeypatch):
    monkeypatch.setattr(pf, "load_all_tools", lambda: [])
    s = p_settings({"Google Workspace": "2026-01-01T00:00:00Z"})
    assert offer_for_gated_server("Google Workspace", s) is None


def test_offer_suppressed_when_already_active(monkeypatch):
    monkeypatch.setattr(
        pf, "load_all_tools",
        lambda: [SimpleNamespace(name="Google Workspace", enabled=True)],
    )
    s = p_settings()
    assert offer_for_gated_server("Google Workspace", s) is None


def test_offer_carries_no_activate_capability(monkeypatch):
    # The security invariant: an offer is data to display, never an action that grants access.
    monkeypatch.setattr(pf, "load_all_tools", lambda: [])
    s = p_settings()
    for entry in CURATED_SHORTLIST:
        o = offer_for_gated_server(entry["id"], s)
        assert o is not None
        assert set(o.keys()) == OFFER_SHAPE, f"offer for {entry['id']} grew an unexpected field"


# --- require_vague: the MCPSearch path keeps suggestions on a concrete prompt ----------------

def p_stub_classifier(is_vague, ids):
    async def p_fake(settings, prompt, available, task_id=None):
        return {"is_vague": is_vague, "suggestions": [{"id": i, "reason": "fits"} for i in ids]}
    return p_fake


def test_preflight_default_suppresses_suggestions_on_concrete_prompt(monkeypatch):
    # Launch path: a concrete (non-vague) prompt must NOT interrupt with a card.
    monkeypatch.setattr(pf, "load_all_tools", lambda: [])
    monkeypatch.setattr(pf, "p_call_classifier", p_stub_classifier(False, ["Google Workspace"]))
    out = asyncio.run(run_preflight("refactor foo.ts to use the new client", timeout_s=5))
    assert out["suggestions"] == []


def test_preflight_require_vague_false_keeps_suggestions(monkeypatch):
    # MCPSearch path: the agent already proved it needs an integration, so keep the suggestion even though the prompt is concrete (is_vague False).
    monkeypatch.setattr(pf, "load_all_tools", lambda: [])
    monkeypatch.setattr(pf, "p_call_classifier", p_stub_classifier(False, ["Google Workspace"]))
    out = asyncio.run(run_preflight("check my unread emails", timeout_s=5, require_vague=False))
    assert [s["id"] for s in out["suggestions"]] == ["Google Workspace"]
    assert set(out["suggestions"][0].keys()) == OFFER_SHAPE


def test_preflight_require_vague_false_still_drops_hallucinated_ids(monkeypatch):
    # require_vague=False must NOT loosen the vetted-id revalidation: a made-up id is still dropped.
    monkeypatch.setattr(pf, "load_all_tools", lambda: [])
    monkeypatch.setattr(pf, "p_call_classifier", p_stub_classifier(False, ["TotallyFakeServer"]))
    out = asyncio.run(run_preflight("do the thing", timeout_s=5, require_vague=False))
    assert out["suggestions"] == []
