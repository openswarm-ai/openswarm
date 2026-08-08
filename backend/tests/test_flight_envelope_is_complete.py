"""The flight envelope has to answer what/who/when/during-what from analytics alone.

The recorder was already built and wired into six error paths, but nothing asserted that what it
emits is COMPLETE. An envelope missing its lane or its breadcrumbs looks fine in a log and is useless
in an investigation, which is the exact failure it exists to prevent: every bug found by hand tonight
(a workflow that resurrected itself, a keyboard tap alive for 2h35m, an editor hung on a stalled aux
call) was silent in analytics.

These force each wired family and assert the envelope a stranger would receive.
"""

from typing import List

import pytest

from backend.apps.agents.core import flight_recorder as fr

# Straight from the clause: what a stranger needs, with no machine in front of them.
P_REQUIRED_FIELDS = {
    "family", "subkind", "lane", "model", "phase", "attempts",
    "breadcrumbs", "journey", "concurrency",
}

# Every family that actually attaches an envelope today (grep: build_envelope call sites).
P_WIRED_FAMILIES: List[tuple] = [
    ("model_error", "provider_500", "stream"),
    ("model_error", "auth_401", "spawn"),
    ("context_overflow", "overflow", "stream"),
    ("cli_binary_missing", "missing", "spawn"),
    ("context_pressure_valve", "pressure_death", "stream"),
    ("empty_finish", "no_answer_text", "stream"),
]


@pytest.fixture(autouse=True)
def p_clean_rings(monkeypatch):
    monkeypatch.setattr(fr, "p_rings", {})
    yield


@pytest.mark.parametrize("family,subkind,phase", P_WIRED_FAMILIES)
def test_every_wired_family_emits_a_complete_envelope(family, subkind, phase):
    sid = f"sess-{family}"
    for i in range(12):
        fr.crumb(sid, "phase", step=i)
    env = fr.build_envelope(sid, family, subkind, "claude-sonnet-5", phase, 3, sessions={})

    missing = P_REQUIRED_FIELDS - set(env)
    assert not missing, f"{family}: envelope is missing {sorted(missing)}"
    assert env["family"] == family
    assert env["subkind"] == subkind
    assert env["phase"] == phase
    assert env["attempts"] == 3
    assert env["lane"], "lane must name WHICH provider the failure happened on"


def test_breadcrumbs_reach_the_ten_the_clause_asks_for():
    sid = "sess-crumbs"
    for i in range(15):
        fr.crumb(sid, "tool_call", n=i)
    env = fr.build_envelope(sid, "model_error", "x", "claude-sonnet-5", "stream", 1, sessions={})
    assert len(env["breadcrumbs"]) >= 10, f"only {len(env['breadcrumbs'])} breadcrumbs"


def test_a_turn_with_no_history_still_emits_a_usable_envelope():
    """A failure at spawn has no breadcrumbs yet; the envelope must still name cause and context
    rather than blowing up, or the earliest failures are exactly the ones we cannot see."""
    env = fr.build_envelope("sess-empty", "cli_binary_missing", "missing", None, "spawn", 0, sessions={})
    assert not (P_REQUIRED_FIELDS - set(env))
    assert env["breadcrumbs"] == []
    assert env["family"] == "cli_binary_missing"


def test_the_envelope_never_raises_on_a_bad_session_id():
    """It is built on the error path. If it can throw, it converts a diagnosable failure into a
    second, undiagnosable one."""
    for sid in ("", "does-not-exist", "\x00weird"):
        env = fr.build_envelope(sid, "model_error", "x", "gpt-5", "stream", 1, sessions={})
        assert env["family"] == "model_error"


def test_the_near_miss_ledger_records_a_silent_recovery():
    """The clause's last line: a recovery the user never saw still needs a denominator."""
    sid = "sess-recover"
    fr.crumb(sid, "api_retry", attempt=1)
    fr.record_recovery(sid, net="router_respawn", model="claude-sonnet-5", attempts=2, sessions={})
    labels = [c.get("l") for c in fr.breadcrumbs(sid)]
    assert "recovered" in labels, f"no recovery breadcrumb, got {labels}"
