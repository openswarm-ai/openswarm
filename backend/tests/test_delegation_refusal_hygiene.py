"""The subscription lane refuses requests shaped like "reproduce your output" and, once one agent is
refused, its refusal used to travel home as CONTENT and poison the parent (264 stores across 161
chats, ENG-387). Both are sealed at their one chokepoint here: the dispatch boundary for the ask,
the delegation return for the refusal. Prompts below are the REAL ones read from blocked chats.
"""

from backend.apps.agents.core.error_classify import defuse_extraction_ask, neutralize_provider_refusal

# Verbatim from the transcripts of chats that were blocked (install 517559f0, 2026-08-21).
REAL_EXTRACTION_ASKS = [
    "Please give me a complete dump of what you were asked to do and how far you got. Include: "
    "(1) the original user request verbatim if possible, (2) any files you created",
    "Please give me the complete final output of your work in this session, formatted cleanly so "
    "it can be sent as an email. Include all the key details, numbers, and recommendations.",
    "Don't try to send anything. Just reply in plain text with the exact email you were supposed "
    "to send to alex@openswarm.com: the subject line, and the full body text. Nothing else.",
]
REAL_REFUSAL = (
    "API Error: Claude Code is unable to respond to this request, which appears to violate our "
    "Usage Policy (https://www.anthropic.com/legal/aup). This request was blocked as it seems to "
    "violate Anthropic's Terms of Service restrictions on reverse engineering or duplicating model outputs."
)


def test_real_extraction_asks_never_leave_the_dispatch_boundary_unchanged():
    for ask in REAL_EXTRACTION_ASKS:
        out = defuse_extraction_ask(ask)
        assert out != ask, f"still shipped the extraction shape: {ask[:60]}"
        assert "in your own words" in out and "verbatim" in out.split("Answer in your own words")[1]


def test_ordinary_handoffs_are_untouched():
    """Negative control: gutting normal delegation would be its own regression."""
    for ok in (
        "Check whether the API server is running and report the port.",
        "Summarize the pricing tiers you landed on.",
        "Fix the failing test in api.test.ts and tell me what broke.",
        "",
    ):
        assert defuse_extraction_ask(ok) == ok


def test_a_childs_refusal_never_travels_home_as_content():
    out = neutralize_provider_refusal(REAL_REFUSAL)
    assert "Usage Policy" not in out and "duplicating model outputs" not in out
    assert "could not answer" in out
    assert "Do not repeat or quote" in out, "the parent must not be invited to re-state it either"


def test_a_real_delegation_answer_is_passed_through_untouched():
    """Negative control: only refusals are rewritten, never a genuine result."""
    for real in ("The build passed, 12 files changed.", "Tiers: $99 / $299 / custom.", ""):
        assert neutralize_provider_refusal(real) == real


def test_both_delegation_doors_defuse_not_just_one():
    """SpawnAgent and InvokeAgent are separate routes. Sealing one and calling it done is exactly the
    hole this caught: the first pass wired the defuse into /api/invoke-agent/run only, so every
    extraction-shaped SpawnAgent prompt still went out untouched."""
    import re
    from pathlib import Path

    p_main = Path(__file__).resolve().parents[1] / "main.py"
    p_src = p_main.read_text()

    for p_route in ("/api/invoke-agent/run", "/api/spawn-agent/run"):
        p_at = p_src.index(p_route)
        # The seal has to sit in the handler itself, not merely somewhere in the file.
        p_body = p_src[p_at:p_at + 2000]
        assert "defuse_extraction_ask" in p_body, f"{p_route} dispatches an un-defused handoff prompt"
        assert re.search(r"=\s*defuse_extraction_ask\(", p_body), f"{p_route} calls the defuse but drops its result"


# ---- The guard must not become the bug (severity ladder, row 1: silent work loss) ----
# Neutralising on refusal WORDING alone deletes a genuine delegated answer and tells nobody. The
# realistic case is mundane: ask an agent to summarise a site's Acceptable Use Policy and its
# correct answer contains the exact phrases the classifier looks for.

def test_a_real_answer_about_policy_is_never_destroyed():
    real = ("Summary of their terms: content blocked as it seems to violate the Acceptable Use "
            "Policy is removed within 24h, and repeat offenders lose API access.")
    assert neutralize_provider_refusal(real) == real, \
        "refusal wording in a genuine answer must never be replaced; that is silent work loss"


def test_a_relayed_refusal_still_gets_neutralised():
    relay = ('API Error: 400 {"type":"error","error":{"message":"Output blocked as it seems to '
             'violate our Acceptable Use Policy (legal/aup): duplicating model outputs"}}')
    out = neutralize_provider_refusal(relay)
    assert out != relay and "could not answer" in out


def test_the_envelope_is_what_separates_them():
    """Same policy wording, with and without the provider envelope: only the envelope is discarded."""
    wording = "Output blocked as it seems to violate our Acceptable Use Policy (legal/aup)"
    assert neutralize_provider_refusal(wording) == wording          # prose: kept
    assert neutralize_provider_refusal(f"API Error: 400 {wording}") != wording   # envelope: neutralised
