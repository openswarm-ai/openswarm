"""Onboarding v3 endpoints: identity decode, local scan, prep fail-open."""

import base64
import json
from pathlib import Path

import pytest

from backend.apps.onboarding.identity import build_identity, decode_jwt_payload
from backend.apps.onboarding.local_scan import run_local_scan
from backend.apps.onboarding.models import PrepRequest, ScanResult
from backend.apps.onboarding.prep import FALLBACK_STARTERS, build_prep, parse_prep
from backend.apps.settings.models import AppSettings


def make_jwt(payload: dict) -> str:
    body = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=")
    return f"header.{body}.sig"


def test_decode_jwt_payload_roundtrip():
    claims = {"email": "eric@example.com", "https://api.openai.com/auth": {"chatgpt_plan_type": "pro"}}
    assert decode_jwt_payload(make_jwt(claims)) == claims


def test_decode_jwt_payload_garbage_is_empty():
    assert decode_jwt_payload("") == {}
    assert decode_jwt_payload("not-a-jwt") == {}
    assert decode_jwt_payload("a.b.c") == {}


def test_build_identity_codex_plan_and_email():
    token = make_jwt({"email": "eric@example.com", "https://api.openai.com/auth": {"chatgpt_plan_type": "plus"}})
    rows = [
        {"provider": "codex", "isActive": True, "idToken": token},
        {"provider": "gemini-cli", "isActive": True, "email": "eric@gmail.com"},
        {"provider": "claude", "isActive": True, "name": "Account 1"},
        {"provider": "codex", "isActive": False, "idToken": token},
        {"provider": "openrouter", "isActive": True},
    ]
    result = build_identity(rows)
    by_provider = {p.provider: p for p in result.providers}
    assert set(by_provider) == {"codex", "gemini-cli", "claude"}
    assert by_provider["codex"].email == "eric@example.com"
    assert by_provider["codex"].plan == "plus"
    assert by_provider["gemini-cli"].email == "eric@gmail.com"
    assert by_provider["claude"].email is None


def test_build_identity_bad_rows_never_raise():
    rows = [{"provider": "codex", "isActive": True, "idToken": 12345}, {"isActive": True}, {}]
    result = build_identity(rows)
    assert [p.provider for p in result.providers] == ["codex"]
    assert result.providers[0].email is None


def test_run_local_scan_counts_names_only(tmp_path: Path):
    downloads = tmp_path / "Downloads"
    downloads.mkdir()
    (downloads / "Screenshot 2026-07-01.png").write_text("x")
    (downloads / "Screen Shot old.png").write_text("x")
    (downloads / "paper.pdf").write_text("x")
    (downloads / ".hidden").write_text("x")
    (tmp_path / ".gitconfig").write_text("[user]")
    repos = tmp_path / "dev"
    (repos / "proj1" / ".git").mkdir(parents=True)
    (repos / "not-a-repo").mkdir()
    result = run_local_scan(tmp_path)
    downloads_summary = next(f for f in result.folders if f.name == "Downloads")
    assert downloads_summary.entry_count == 3
    assert downloads_summary.screenshot_count == 2
    assert "png" in downloads_summary.top_extensions and "pdf" in downloads_summary.top_extensions
    desktop_summary = next(f for f in result.folders if f.name == "Desktop")
    assert desktop_summary.entry_count == 0
    assert result.git_repo_count == 1
    assert result.has_gitconfig is True
    serialized = json.dumps(result.model_dump())
    assert "[user]" not in serialized


def test_parse_prep_strict_and_lenient():
    good = '{"greeting": "Hey!", "starters": [{"title": "A", "prompt": "do a"}, {"title": "B", "prompt": "do b"}]}'
    parsed = parse_prep(f"Sure! Here you go: {good}")
    assert parsed is not None
    assert parsed.greeting == "Hey!"
    assert [s.title for s in parsed.starters] == ["A", "B"]
    # Reason is optional; missing reason defaults to empty, never drops the starter.
    assert parsed.starters[0].reason == ""
    assert parse_prep("no json here") is None
    assert parse_prep('{"greeting": "hi", "starters": []}') is None


def test_parse_prep_carries_reasons():
    rich = (
        '{"greeting": "Hey!", "app_title": "Lift Log", "app_prompt": "Build me a lifting tracker", '
        '"app_reason": "you plan lifts with ChatGPT daily", '
        '"starters": [{"title": "Audit Downloads", "prompt": "audit it", "reason": "1,305 files piling up there"}]}'
    )
    parsed = parse_prep(rich)
    assert parsed is not None
    assert parsed.starters[0].reason == "1,305 files piling up there"
    assert parsed.app_reason == "you plan lifts with ChatGPT daily"


@pytest.mark.asyncio
async def test_build_prep_fails_open_without_provider(monkeypatch):
    async def boom(*args, **kwargs):
        raise ValueError("no provider connected")

    monkeypatch.setattr("backend.apps.agents.providers.registry.resolve_aux_model", boom)
    result = await build_prep(AppSettings(), PrepRequest(scan=ScanResult(), picked_apps=["notion"]))
    assert result.greeting == ""
    assert result.starters == FALLBACK_STARTERS
