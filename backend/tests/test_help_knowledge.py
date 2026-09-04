"""The help chat's knowledge feed. The invariants here are all about honesty: the facts must be
present, the shortcuts must be the user's real ones, and the prompt must forbid guessing.

A help assistant that invents a menu item is the failure mode this whole feature exists to prevent,
so the grounding rules are pinned by test rather than trusted to survive a future prompt edit.
"""

from fastapi.testclient import TestClient

from backend.apps.help.help_topics import HELP_TOPICS
from backend.apps.help.knowledge import (
    build_knowledge_response,
    build_shortcuts,
    build_system_prompt,
    render_combo,
)
from backend.apps.help.known_issues import KNOWN_ISSUES
from backend.main import app


def test_knowledge_endpoint_serves_topics_and_issues():
    import backend.auth as auth_mod

    with TestClient(app, headers={"Authorization": f"Bearer {auth_mod.TOKEN}"}) as client:
        res = client.get("/api/help/knowledge")
    assert res.status_code == 200
    body = res.json()
    assert len(body["topics"]) == len(HELP_TOPICS)
    assert len(body["known_issues"]) == len(KNOWN_ISSUES)
    assert body["system_prompt"]
    assert body["app_version"]


def test_every_topic_is_self_contained():
    """Kapa's rule: a chunk retrieved alone still has to make sense alone."""
    for topic in HELP_TOPICS:
        assert topic.id and topic.title and topic.body
        assert topic.keywords, f"{topic.id} has no keywords, so local search can never find it"
        assert len(topic.body) > 40, f"{topic.id} body is too thin to answer anything"


def test_topic_ids_are_unique():
    ids = [t.id for t in HELP_TOPICS]
    assert len(ids) == len(set(ids))


def test_known_issues_never_carry_a_fix_date_or_eta():
    """Bug status is the easiest thing to lie about, so the data itself must not invite it."""
    for issue in KNOWN_ISSUES:
        assert issue.status in ("known", "mitigated", "fixed")
        assert issue.detail
        for banned in ("ETA", "next release", "soon", "will be fixed"):
            assert banned.lower() not in issue.detail.lower()


def test_render_combo_matches_the_platform():
    from backend.apps.help.knowledge import IS_MAC

    if IS_MAC:
        assert render_combo("Meta+l") == "⌘L"
        assert render_combo("Meta+Shift+d") == "⌘⇧D"
    else:
        assert render_combo("Meta+l") == "Ctrl+L"
        assert render_combo("Meta+Shift+d") == "Ctrl+Shift+D"


def test_shortcuts_use_the_users_configured_combo_not_the_default():
    shortcuts = build_shortcuts("Meta+Shift+j", "Alt+m")
    new_chat = next(s for s in shortcuts if s.action == "Open the new-chat composer")
    dictation = next(s for s in shortcuts if "dictation" in s.action)
    assert new_chat.keys == render_combo("Meta+Shift+j")
    assert dictation.keys == render_combo("Alt+m")


def test_dictation_falls_back_to_the_platform_default_when_unset():
    from backend.apps.help.knowledge import dictation_default_combo

    shortcuts = build_shortcuts("Meta+l", None)
    dictation = next(s for s in shortcuts if "dictation" in s.action)
    assert dictation.keys == render_combo(dictation_default_combo())


def test_prompt_forbids_guessing_and_permits_not_knowing():
    prompt = build_knowledge_response([]).system_prompt
    assert "Never invent a button" in prompt
    assert "Never invent a bug status" in prompt
    assert "you don't know" in prompt.lower()
    # The refusal has to be framed as acceptable, or the model treats it as a last resort.
    assert "not a failure" in prompt


def test_prompt_states_it_cannot_see_live_bug_reports():
    prompt = build_knowledge_response([]).system_prompt
    assert "cannot see live bug reports" in prompt
    assert "no live view of" in prompt


def test_prompt_carries_every_topic_and_issue():
    prompt = build_system_prompt(build_shortcuts("Meta+l", None), "9.9.9", "on their own API key")
    for topic in HELP_TOPICS:
        assert f"[{topic.id}]" in prompt
    for issue in KNOWN_ISSUES:
        assert f"[{issue.id}]" in prompt
    assert "9.9.9" in prompt


def test_prompt_stays_within_a_sane_token_budget():
    """It rides the cached prefix, but an unbounded knowledge blob still costs a cache write."""
    prompt = build_knowledge_response([]).system_prompt
    assert len(prompt) < 24_000, "help knowledge is growing past its budget; tighten the topics"
