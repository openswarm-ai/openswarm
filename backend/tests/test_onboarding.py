"""Onboarding v3 endpoints: identity decode, local scan, prep fail-open."""

import base64
import json
from pathlib import Path

import pytest

from backend.apps.onboarding.identity import build_identity, decode_jwt_payload
from backend.apps.onboarding.local_scan import detect_signal_apps, run_local_scan
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


def test_signal_apps_picks_tools_not_noise_and_avoids_substring_traps():
    apps = ["Calculator", "Xcode", "Visual Studio Code", "Figma", "Search", "System Settings", "Adobe Photoshop 2024", "Arc"]
    signal = detect_signal_apps(apps)
    assert "Xcode" in signal and "Visual Studio Code" in signal and "Figma" in signal
    assert "Adobe Photoshop 2024" in signal  # prefix match on a versioned name
    assert "Arc" in signal
    # "Search" contains "arc" as a substring but must NOT be treated as the Arc browser.
    assert "Search" not in signal
    assert "Calculator" not in signal and "System Settings" not in signal


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


def test_summarize_chatgpt_usage_leads_with_memory_and_caps():
    from backend.apps.onboarding.usage.chatgpt_usage import TOTAL_CONVO_CHARS, summarize_chatgpt_usage

    s = summarize_chatgpt_usage(
        812,
        ["Has an Akita", "Squats 495"],
        ["Swift concurrency", "Deadlift form"],
        ["User: fix my squat form?\nAssistant: brace harder."],
    )
    assert "812 past AI conversations" in s
    assert "Has an Akita; Squats 495" in s
    assert "Swift concurrency; Deadlift form" in s
    assert "fix my squat form?" in s
    big = summarize_chatgpt_usage(
        1000,
        [],
        [f"t{i}x" for i in range(1000)],
        ["c" * 60000 for _ in range(10)],
    )
    assert "t149x" in big and "t150x" not in big
    convo_block = big.split("real asks + the exchange")[1]
    assert len(convo_block) <= TOTAL_CONVO_CHARS + 10000


@pytest.mark.asyncio
async def test_harvest_chatgpt_usage_fails_open_without_codex(monkeypatch):
    from backend.apps.onboarding.usage import chatgpt_usage

    monkeypatch.setattr(chatgpt_usage, "read_persisted_connections", lambda: [])
    assert await chatgpt_usage.harvest_chatgpt_usage() == ""


def test_read_provider_cookies_fails_open_without_a_store(monkeypatch):
    from backend.apps.onboarding.usage import browser_cookies

    # No browser store has the domain -> empty jar/records, and the keychain is never touched.
    monkeypatch.setattr(browser_cookies, "p_best_store", lambda domain: None)
    assert browser_cookies.read_provider_cookies("claude.ai") == {}
    assert browser_cookies.read_provider_cookie_records("claude.ai") == []


def test_dump_cookies_only_serves_allowlisted_domains(monkeypatch, capsys):
    from backend.apps.onboarding.usage import dump_cookies

    # Patch the names in dump_cookies' own namespace, so a real read (+ keychain) never fires.
    monkeypatch.setattr(dump_cookies, "read_provider_cookie_records", lambda domain: [{"name": "x", "value": "y"}])
    monkeypatch.setattr(dump_cookies, "read_google_session_records", lambda: [{"name": "SID", "value": "g"}])
    # An off-list domain must never trigger a read, prints [].
    monkeypatch.setattr("sys.argv", ["dump_cookies", "evil.example.com"])
    dump_cookies.main()
    assert capsys.readouterr().out == "[]"
    # An allowlisted domain passes through to the reader.
    monkeypatch.setattr("sys.argv", ["dump_cookies", "claude.ai"])
    dump_cookies.main()
    assert '"name": "x"' in capsys.readouterr().out
    # Gemini routes to the SCOPED google reader, not a raw gemini.google.com read.
    monkeypatch.setattr("sys.argv", ["dump_cookies", "gemini.google.com"])
    dump_cookies.main()
    assert '"name": "SID"' in capsys.readouterr().out


def test_read_google_session_records_scopes_to_named_auth_cookies(monkeypatch):
    from backend.apps.onboarding.usage import browser_cookies

    seen_domain = {}

    def fake_records(domain: str):
        seen_domain["d"] = domain
        return [
            {"name": "SID", "value": "a"},
            {"name": "__Secure-1PSID", "value": "b"},
            {"name": "SEARCH_SAMESITE", "value": "c"},  # non-auth google cookie
            {"name": "OTZ", "value": "d"},  # non-auth google cookie
        ]

    monkeypatch.setattr(browser_cookies, "read_provider_cookie_records", fake_records)
    recs = browser_cookies.read_google_session_records()
    # Reads the parent SSO domain, then keeps ONLY the named auth cookies (never a full sweep).
    assert seen_domain["d"] == ".google.com"
    assert {r["name"] for r in recs} == {"SID", "__Secure-1PSID"}


def test_summarize_claude_usage_counts_and_caps():
    from backend.apps.onboarding.usage.claude_usage import TOTAL_CONVO_CHARS, summarize_claude_usage

    s = summarize_claude_usage(
        490,
        ["Yuji Itadori and Buddhism", "B2B SaaS Startup Ideas"],
        ["User: pitch me a startup\nAssistant: sure."],
    )
    assert "490 past Claude conversations" in s
    assert "Yuji Itadori and Buddhism; B2B SaaS Startup Ideas" in s
    assert "pitch me a startup" in s
    big = summarize_claude_usage(1000, [f"t{i}x" for i in range(1000)], ["c" * 60000 for _ in range(10)])
    assert "t149x" in big and "t150x" not in big
    convo_block = big.split("real asks + the exchange")[1]
    assert len(convo_block) <= TOTAL_CONVO_CHARS + 10000


@pytest.mark.asyncio
async def test_harvest_claude_usage_fails_open_without_cookies(monkeypatch):
    from backend.apps.onboarding.usage import claude_usage

    monkeypatch.setattr(claude_usage, "read_provider_cookies", lambda domain: {})
    assert await claude_usage.harvest_claude_usage() == ""


@pytest.mark.asyncio
async def test_build_prep_fails_open_without_provider(monkeypatch):
    async def boom(*args, **kwargs):
        raise ValueError("no provider connected")

    monkeypatch.setattr("backend.apps.agents.providers.registry.resolve_aux_model", boom)
    result = await build_prep(AppSettings(), PrepRequest(scan=ScanResult(), picked_apps=["notion"]))
    assert result.greeting == ""
    assert result.starters == FALLBACK_STARTERS
