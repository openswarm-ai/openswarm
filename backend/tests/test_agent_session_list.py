import asyncio

from pytest import MonkeyPatch

from backend.apps.agents import agents as agents_module
from backend.apps.agents.core.models import AgentSession, Message


def test_session_list_item_replaces_messages_with_compact_metadata(
    monkeypatch: MonkeyPatch,
) -> None:
    first_prompt = "p" * 250
    last_reply = "r" * 150
    session = AgentSession(
        name="Test session",
        messages=[
            Message(role="system", content="system"),
            Message(role="user", content=first_prompt),
            Message(role="assistant", content=last_reply),
        ],
    )

    monkeypatch.setattr(
        agents_module.agent_manager,
        "get_all_sessions",
        lambda dashboard_id=None: [session],
    )
    item = asyncio.run(agents_module.list_sessions())["sessions"][0]

    assert item["messages"] == []
    assert item["message_count"] == 3
    assert item["first_user_message"] == first_prompt[:200]
    assert item["last_message_preview"] == last_reply[:120]


def test_session_list_item_handles_empty_and_non_text_content(
    monkeypatch: MonkeyPatch,
) -> None:
    sessions = [
        AgentSession(name="Empty"),
        AgentSession(
            name="Images",
            messages=[Message(role="user", content=[{"type": "image"}])],
        ),
    ]
    monkeypatch.setattr(
        agents_module.agent_manager,
        "get_all_sessions",
        lambda dashboard_id=None: sessions,
    )
    empty, non_text = asyncio.run(agents_module.list_sessions())["sessions"]

    assert empty["messages"] == []
    assert empty["message_count"] == 0
    assert empty["first_user_message"] == ""
    assert empty["last_message_preview"] == ""
    assert non_text["message_count"] == 1
    assert non_text["first_user_message"] == ""
    assert non_text["last_message_preview"] == ""
