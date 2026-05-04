"""Tests for `backend.apps.agents.mcp_preflight`.

Currently 0% covered. Drives the public entry point `run_preflight` and
the helpers behind it. The aux-model call is mocked at the function
boundary (`_call_classifier`); no real Anthropic / 9Router traffic.

Coverage targets:
  - `_is_obviously_local`: short / shell-prefixed / single-path /
    normal prompts
  - `_build_available_shortlist`: enabled tools removed, dismissed
    entries removed
  - `_decorate`: known id → full payload, unknown id → None,
    `reason` truncated to 200 chars
  - `run_preflight`:
    - empty prompt → default
    - obviously-local prompt → default (no LLM call)
    - happy path → returns classifier JSON, suggestions decorated
    - is_vague=False zeros suggestions (concrete-prompt guard)
    - hallucinated id outside CURATED_SHORTLIST dropped
    - timeout → default (fail-open)
    - generic exception → default (fail-open)
  - `_call_classifier` JSON cleanup with code-fence wrapping
"""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from backend.apps.agents import mcp_preflight as pf
from backend.apps.agents.mcp_preflight import (
    CURATED_SHORTLIST,
    _build_available_shortlist,
    _call_classifier,
    _decorate,
    _is_obviously_local,
    run_preflight,
)
from backend.apps.settings.models import AppSettings


# ---------------------------------------------------------------------------
# _is_obviously_local
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "prompt,expected",
    [
        ("", True),  # < 8 chars
        ("hi", True),
        ("ok thx", True),
        ("$ git status", True),  # shell prefix
        ("! ls", True),
        ("/clear", True),
        ("./src/foo.ts", True),  # single path-like token
        ("README.md", True),  # extension match
        ("/tmp/whatever.json", True),
        ("write me an email about the demo", False),
        ("summarize my notes from the meeting yesterday", False),
        ("./src/foo.ts has a bug, fix it", False),  # multi-token
    ],
)
def test_is_obviously_local(prompt: str, expected: bool):
    assert _is_obviously_local(prompt) is expected


# ---------------------------------------------------------------------------
# _build_available_shortlist
# ---------------------------------------------------------------------------


def _fake_tool(name: str, *, enabled: bool = True) -> object:
    return SimpleNamespace(name=name, enabled=enabled)


def test_build_available_shortlist_enabled_tools_removed():
    """If a curated entry's `id` matches an enabled tool, it must NOT
    appear in the shortlist (already connected → nothing to suggest)."""
    settings = AppSettings()
    with patch.object(pf, "load_all_tools", return_value=[
        _fake_tool("Slack", enabled=True),
        _fake_tool("Notion", enabled=False),  # disabled doesn't filter
    ]):
        out = _build_available_shortlist(settings)
    ids = {e["id"] for e in out}
    assert "Slack" not in ids
    assert "Notion" in ids


def test_build_available_shortlist_dismissed_entries_filtered():
    """User-dismissed suggestions are suppressed on subsequent launches."""
    settings = AppSettings(dismissed_mcp_suggestions={"Reddit": "2026-04-30T00:00:00"})
    with patch.object(pf, "load_all_tools", return_value=[]):
        out = _build_available_shortlist(settings)
    ids = {e["id"] for e in out}
    assert "Reddit" not in ids


def test_build_available_shortlist_handles_load_tools_exception():
    """If load_all_tools raises, the helper falls back to "no enabled
    tools" rather than crashing."""
    settings = AppSettings()
    with patch.object(pf, "load_all_tools", side_effect=RuntimeError("disk gone")):
        out = _build_available_shortlist(settings)
    # No enabled / no dismissed → entire curated shortlist returned
    assert len(out) == len(CURATED_SHORTLIST)


# ---------------------------------------------------------------------------
# _decorate
# ---------------------------------------------------------------------------


def test_decorate_known_id_returns_full_shape():
    available = list(CURATED_SHORTLIST)
    out = _decorate({"id": "Slack", "reason": "user mentioned channel"}, available)
    assert out is not None
    assert out["id"] == "Slack"
    assert out["title"] == "Slack"
    assert "Search channels" in out["description"]
    assert out["reason"] == "user mentioned channel"


def test_decorate_unknown_id_returns_none():
    out = _decorate({"id": "DefinitelyNotReal", "reason": "x"}, list(CURATED_SHORTLIST))
    assert out is None


def test_decorate_truncates_reason_to_200_chars():
    long_reason = "x" * 500
    out = _decorate({"id": "Slack", "reason": long_reason}, list(CURATED_SHORTLIST))
    assert out is not None
    assert len(out["reason"]) == 200


def test_decorate_missing_reason_becomes_empty_string():
    out = _decorate({"id": "Slack"}, list(CURATED_SHORTLIST))
    assert out is not None
    assert out["reason"] == ""


# ---------------------------------------------------------------------------
# run_preflight — early returns
# ---------------------------------------------------------------------------


async def test_run_preflight_empty_prompt_returns_default():
    out = await run_preflight("")
    assert out == {"is_vague": False, "suggestions": []}


async def test_run_preflight_whitespace_only_returns_default():
    out = await run_preflight("   \n\t  ")
    assert out == {"is_vague": False, "suggestions": []}


async def test_run_preflight_obviously_local_skips_classifier():
    """Local prompts must short-circuit BEFORE any classifier call."""
    classifier = AsyncMock()
    with patch.object(pf, "_call_classifier", classifier):
        out = await run_preflight("./src/foo.ts")
    assert out == {"is_vague": False, "suggestions": []}
    classifier.assert_not_called()


# ---------------------------------------------------------------------------
# run_preflight — happy path
# ---------------------------------------------------------------------------


async def test_run_preflight_happy_path_decorates_suggestions():
    classifier_result = {
        "is_vague": True,
        "suggestions": [
            {"id": "Slack", "reason": "user mentioned channel"},
            {"id": "Notion", "reason": "wants to update notes"},
        ],
    }
    with patch.object(pf, "_call_classifier", AsyncMock(return_value=classifier_result)):
        out = await run_preflight("send a status update to the team channel")

    assert out["is_vague"] is True
    ids = {s["id"] for s in out["suggestions"]}
    assert ids == {"Slack", "Notion"}
    # Decorated to full shape
    slack = next(s for s in out["suggestions"] if s["id"] == "Slack")
    assert slack["title"] == "Slack"
    assert slack["reason"] == "user mentioned channel"


async def test_run_preflight_concrete_prompt_zeros_suggestions():
    """is_vague=False MUST suppress all suggestions, even if the
    classifier returned some — concrete tasks shouldn't be interrupted
    with a connect-mcp modal."""
    classifier_result = {
        "is_vague": False,
        "suggestions": [{"id": "Slack", "reason": "x"}],
    }
    with patch.object(pf, "_call_classifier", AsyncMock(return_value=classifier_result)):
        out = await run_preflight("refactor foo.ts to use async/await")
    assert out["is_vague"] is False
    assert out["suggestions"] == []


async def test_run_preflight_drops_hallucinated_ids():
    """The classifier may invent an id — preflight must filter against
    `CURATED_SHORTLIST` so the frontend never sees a phantom."""
    classifier_result = {
        "is_vague": True,
        "suggestions": [
            {"id": "Slack", "reason": "ok"},
            {"id": "PhantomService", "reason": "made up"},
            {"id": "AnotherFake", "reason": "also made up"},
        ],
    }
    with patch.object(pf, "_call_classifier", AsyncMock(return_value=classifier_result)):
        out = await run_preflight("write me an email summarizing the call")

    ids = {s["id"] for s in out["suggestions"]}
    assert "PhantomService" not in ids
    assert "AnotherFake" not in ids
    assert "Slack" in ids


async def test_run_preflight_drops_already_enabled_after_classifier():
    """If the user enables an MCP between preflight start and classifier
    return, the suggestion should be dropped (matches `available` is
    None in `_decorate`)."""
    settings = AppSettings()
    classifier_result = {
        "is_vague": True,
        "suggestions": [
            {"id": "Slack", "reason": "channel"},  # will be enabled (filtered out)
            {"id": "Notion", "reason": "notes"},
        ],
    }

    with patch.object(pf, "load_all_tools", return_value=[
        _fake_tool("Slack", enabled=True),  # enabled mid-flight
    ]), patch.object(pf, "load_settings", return_value=settings), \
         patch.object(pf, "_call_classifier", AsyncMock(return_value=classifier_result)):
        out = await run_preflight("ping the team in our channel and update the doc")

    ids = {s["id"] for s in out["suggestions"]}
    assert "Slack" not in ids
    assert "Notion" in ids


async def test_run_preflight_non_dict_suggestion_filtered():
    """Defensive: classifier might return non-dict items in the
    suggestions list (e.g. a bare string). They must be silently
    dropped, not crash decoration."""
    classifier_result = {
        "is_vague": True,
        "suggestions": [
            "not a dict",
            {"id": "Slack", "reason": "real one"},
        ],
    }
    with patch.object(pf, "_call_classifier", AsyncMock(return_value=classifier_result)):
        out = await run_preflight("send a status update to the team channel")
    assert [s["id"] for s in out["suggestions"]] == ["Slack"]


# ---------------------------------------------------------------------------
# run_preflight — fail-open contract
# ---------------------------------------------------------------------------


async def test_run_preflight_classifier_timeout_returns_default():
    """asyncio.TimeoutError → default. Real path: aux model is slow."""
    async def _slow(*_args, **_kw):
        await asyncio.sleep(10)
        return {}

    with patch.object(pf, "_call_classifier", _slow):
        out = await run_preflight("write me an email summarizing the call", timeout_s=0.05)
    assert out == {"is_vague": False, "suggestions": []}


async def test_run_preflight_classifier_exception_returns_default():
    """Any other exception (network, bad JSON, ValueError) must fail
    open with the default response."""
    with patch.object(pf, "_call_classifier", AsyncMock(side_effect=RuntimeError("boom"))):
        out = await run_preflight("write me an email summarizing the call")
    assert out == {"is_vague": False, "suggestions": []}


async def test_run_preflight_no_provider_classifier_value_error_returns_default():
    """resolve_aux_model raises ValueError when no provider is wired —
    that surfaces inside the classifier and must fail open."""
    with patch.object(pf, "_call_classifier",
                      AsyncMock(side_effect=ValueError("no provider"))):
        out = await run_preflight("send a status update to the team channel")
    assert out == {"is_vague": False, "suggestions": []}


# ---------------------------------------------------------------------------
# _call_classifier — JSON cleanup paths
# ---------------------------------------------------------------------------


def _make_classifier_setup(text: str):
    """Build the patches needed to drive _call_classifier with a fake
    Anthropic client returning `text` as the assistant content."""
    from backend.apps.agents.mcp_preflight import resolve_aux_model as _real

    fake_resp = SimpleNamespace(
        content=[SimpleNamespace(text=text)],
    )
    fake_client = MagicMock()
    fake_client.messages = MagicMock()
    fake_client.messages.create = AsyncMock(return_value=fake_resp)

    return (
        patch.object(pf, "resolve_aux_model",
                     AsyncMock(return_value=("claude-haiku-4-5", None))),
        patch.object(pf, "get_anthropic_client", return_value=fake_client),
    )


async def test_call_classifier_strips_markdown_code_fences():
    """Some models wrap JSON in ```json fences — preflight must strip
    them before parsing."""
    fenced = '```json\n{"is_vague": true, "suggestions": []}\n```'
    aux_p, client_p = _make_classifier_setup(fenced)
    with aux_p, client_p:
        data = await _call_classifier(AppSettings(), "anything", [])
    assert data == {"is_vague": True, "suggestions": []}


async def test_call_classifier_strips_plain_code_fences():
    """``` (without `json` tag) also stripped."""
    fenced = '```\n{"is_vague": false, "suggestions": []}\n```'
    aux_p, client_p = _make_classifier_setup(fenced)
    with aux_p, client_p:
        data = await _call_classifier(AppSettings(), "anything", [])
    assert data["is_vague"] is False


async def test_call_classifier_normalizes_non_list_suggestions():
    """If the model returns suggestions as a non-list (e.g. None or
    dict), normalize to []."""
    text = '{"is_vague": true, "suggestions": null}'
    aux_p, client_p = _make_classifier_setup(text)
    with aux_p, client_p:
        data = await _call_classifier(AppSettings(), "anything", [])
    assert data["suggestions"] == []


async def test_call_classifier_raises_on_non_object_root():
    text = '"not an object"'
    aux_p, client_p = _make_classifier_setup(text)
    with aux_p, client_p, pytest.raises(ValueError):
        await _call_classifier(AppSettings(), "anything", [])


async def test_call_classifier_handles_string_content_response():
    """Some translators return content as a single string instead of a
    list of blocks. Adapter must coerce gracefully."""
    fake_resp = SimpleNamespace(content='{"is_vague": false, "suggestions": []}')
    fake_client = MagicMock()
    fake_client.messages = MagicMock()
    fake_client.messages.create = AsyncMock(return_value=fake_resp)
    with patch.object(pf, "resolve_aux_model",
                      AsyncMock(return_value=("claude-haiku-4-5", None))), \
         patch.object(pf, "get_anthropic_client", return_value=fake_client):
        data = await _call_classifier(AppSettings(), "anything", [])
    assert data == {"is_vague": False, "suggestions": []}


async def test_call_classifier_passes_aux_model_into_request():
    """Verify the resolved aux model id reaches the upstream call."""
    fake_resp = SimpleNamespace(content=[SimpleNamespace(text='{"is_vague": false}')])
    fake_client = MagicMock()
    fake_client.messages = MagicMock()
    fake_client.messages.create = AsyncMock(return_value=fake_resp)
    with patch.object(pf, "resolve_aux_model",
                      AsyncMock(return_value=("cc/claude-haiku-4-5-20251001", None))), \
         patch.object(pf, "get_anthropic_client", return_value=fake_client):
        await _call_classifier(AppSettings(), "anything", [])

    _, kwargs = fake_client.messages.create.call_args
    assert kwargs["model"] == "cc/claude-haiku-4-5-20251001"
    assert kwargs["max_tokens"] == 300
    assert "is_vague" in kwargs["system"]
