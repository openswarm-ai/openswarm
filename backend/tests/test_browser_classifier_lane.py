"""The fast-path classifier must not let a mute provider disable the browser fast path.

Measured live 2026-07-26: on the codex lane the aux resolves to cx/gpt-5.4-mini, which returns an
EMPTY body for this call. Empty parsed to verdict 'no', which reads identically to "this is not a
browser task", so the entire browser fast path silently switched off for every GPT user with no
error to show for it (gpt-5.4 filled 0/3; after the empty-body fallback, 2/2). These tests pin both
halves of the contract: the parser may call empty 'no', and the caller must not accept that as a
verdict when a provider was pinned.
"""
from backend.apps.agents.browser import browser_fast_path as fp

CLAUDE_REPLY = "ACT\n\nENTRY: https://x.com/home\n\n1. Navigate to X.\n2. Click the composer."


def test_empty_body_parses_as_no() -> None:
    """The parser is allowed to say 'no' on empty; the BUG was the caller treating that as a real
    verdict instead of a mute lane."""
    assert fp.parse_verdict_and_brief("") == ("no", "")


def test_whitespace_only_body_is_treated_as_empty() -> None:
    """A lane answering with only whitespace is exactly as mute as one answering ''."""
    assert fp.parse_verdict_and_brief("   \n\t \n") == ("no", "")


def test_real_verdict_still_parses() -> None:
    verdict, brief = fp.parse_verdict_and_brief(CLAUDE_REPLY)
    assert verdict == "act"
    assert "ENTRY: https://x.com/home" in brief


def test_read_verdict_still_parses() -> None:
    verdict, _ = fp.parse_verdict_and_brief("READ\n\nENTRY: https://example.com")
    assert verdict == "read"


def test_caller_retries_provider_agnostic_on_a_mute_lane() -> None:
    """The fix itself: classify_and_brief must re-ask WITHOUT the provider pin when the pinned lane
    returns nothing. Pinned by source so the retry cannot be quietly deleted."""
    import inspect
    src = inspect.getsource(fp.classify_and_brief)
    assert "if not text.strip() and primary_api:" in src, "empty-body fallback missing"
    assert "p_ask(None)" in src, "fallback must drop the provider pin"
